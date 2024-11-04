import './style.css';
import firebase from 'firebase/app';
import 'firebase/firestore';
import { getData, getDataById } from './dbFunctions.js'; 
import { validateAnswer, formatValidationResult } from './geminiService.js';
require('dotenv').config();


// Firebase config
const firebaseConfig = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
    measurementId: process.env.FIREBASE_MEASUREMENT_ID
  };

// Initialize Firebase
if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}
const firestore = firebase.firestore();

const servers = {
  iceServers: [
    {
      urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'],
    },
  ],
  iceCandidatePoolSize: 10,
};

// Question Management State
let usedQuestionIds = new Set();
let availableQuestionIds = [];
let totalQuestions = 0;
let sampleQuestion = "Loading question...";

// Global State
let pc = new RTCPeerConnection(servers);
let localStream = null;
let remoteStream = null;
let currentCallDoc = null;
let isUnmuteButtonLocked = false;
let recognition = null;
let recognitionTimeout = null;

// Text-to-Speech state
let synth = window.speechSynthesis;
let speaking = false;
let currentUtterance = null;
let isPaused = false;
let pausedPosition = 0;

// HTML elements
const webcamButton = document.getElementById('webcamButton');
const webcamVideo = document.getElementById('webcamVideo');
const callButton = document.getElementById('callButton');
const callInput = document.getElementById('callInput');
const answerButton = document.getElementById('answerButton');
const remoteVideo = document.getElementById('remoteVideo');
const hangupButton = document.getElementById('hangupButton');
const unmuteButton = document.getElementById('unmuteButton');
const readQuestionButton = document.getElementById('readQuestionButton');
const timerDisplay = document.getElementById('timer');

const showAnswerStatus = (isCorrect, explanation) => {
  const statusElement = document.getElementById('answerStatus');
  statusElement.textContent = isCorrect ? '✓ Correct!' : '✗ Incorrect';
  statusElement.className = 'answer-status ' + (isCorrect ? 'correct' : 'incorrect');
  statusElement.style.display = 'block';
  statusElement.style.opacity = '1';

  // Hide the status after 3 seconds
  setTimeout(() => {
      statusElement.style.opacity = '0';
      setTimeout(() => {
          statusElement.style.display = 'none';
          statusElement.style.opacity = '1';
      }, 300);
  }, 3000);
};

// Question Pool Management
async function initializeQuestionPool() {
  try {
      const data = await getData();
      const questions = data.response;
      totalQuestions = questions.length;
      
      // Create array of all question IDs (using index as ID)
      availableQuestionIds = Array.from({ length: totalQuestions }, (_, i) => i);
      
      // Shuffle the array
      shuffleArray(availableQuestionIds);
      
      console.log(`Initialized question pool with ${totalQuestions} questions`);
      
      // Load first question
      await loadRandomQuestion();
  } catch (error) {
      console.error('Error initializing question pool:', error);
      sampleQuestion = "What planet is known as the Red Planet due to its reddish appearance?";
  }
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

// Modified load random question function to handle the data structure
async function loadRandomQuestion() {
  try {
      // Check if we need to reset the pool
      if (availableQuestionIds.length === 0) {
          console.log('Reshuffling question pool...');
          const data = await getData();
          const questions = data.response;
          availableQuestionIds = Array.from({ length: questions.length }, (_, i) => i);
          shuffleArray(availableQuestionIds);
          usedQuestionIds.clear();
      }

      const questionId = availableQuestionIds.pop();
      usedQuestionIds.add(questionId);

      const data = await getData();
      const questions = data.response;
      const questionData = questions[questionId];
      
      // The question is in the first element of the inner array
      sampleQuestion = questionData[0];
      
      console.log(`Loaded question ${questionId}:`, sampleQuestion);
      
      if (currentUtterance) {
          currentUtterance.text = sampleQuestion;
      }

      return true;
  } catch (error) {
      console.error('Error loading question:', error);
      sampleQuestion = "Error loading question. Please try again.";
      return false;
  }
}

// Function to get the best available voice
const getBestVoice = () => {
    const voices = synth.getVoices();
    console.log('Available voices:', voices.map(v => `${v.name} (${v.lang})`));
    
    const preferredVoices = [
        'Microsoft Libby Online (Natural)',
        'Microsoft Sarah Online (Natural)',
        'Microsoft David Online (Natural)',
        'Google UK English Female',
        'Google UK English Male',
        'Karen',
        'Daniel',
        'Samantha',
        'Google US English',
        'Microsoft Zira Online'
    ];

    for (const preferredVoice of preferredVoices) {
        const voice = voices.find(v => v.name.includes(preferredVoice));
        if (voice) return voice;
    }

    const englishVoice = voices.find(voice => 
        voice.lang.startsWith('en') && 
        (voice.name.includes('Female') || voice.name.includes('natural'))
    );
    
    if (englishVoice) return englishVoice;
    return voices[0];
};

// Modified read question function
const readQuestion = (startPosition = 0) => {
  console.log('Reading from position:', startPosition);
  
  // Check if we should actually start reading
  if (isUnmuteButtonLocked) {
      console.log('Cannot start reading while unmuted');
      return;
  }
  
  synth.cancel();
  
  const textToRead = sampleQuestion.slice(startPosition);
  currentUtterance = new SpeechSynthesisUtterance(textToRead);
  
  currentUtterance.rate = 0.9;
  currentUtterance.pitch = 1.0;
  currentUtterance.volume = 1.0;
  currentUtterance.lang = 'en-US';
  currentUtterance.voice = getBestVoice();

  currentUtterance.onstart = () => {
      speaking = true;
      isPaused = false;
      readQuestionButton.textContent = 'Stop Reading';
      console.log('TTS started:', { speaking, isPaused, pausedPosition });
      
      // Only update Firebase if not during unmute period
      if (!isUnmuteButtonLocked && currentCallDoc) {
          currentCallDoc.update({
              ttsState: {
                  speaking: true,
                  isPaused: false,
                  wasSpeaking: true
              }
          }).catch(error => {
              console.error('Error updating TTS state:', error);
          });
      }
  };

  currentUtterance.onend = () => {
      if (!isPaused) {
          speaking = false;
          pausedPosition = 0;
          readQuestionButton.textContent = 'Read Question';
          console.log('TTS ended naturally:', { speaking, isPaused, pausedPosition });
          
          // Only update Firebase if not during unmute period
          if (!isUnmuteButtonLocked && currentCallDoc) {
              currentCallDoc.update({
                  ttsState: {
                      speaking: false,
                      isPaused: false,
                      wasSpeaking: false
                  }
              }).catch(error => {
                  console.error('Error updating TTS state:', error);
              });
          }
      }
  };

  speaking = true;
  synth.speak(currentUtterance);
};

// Modified pauseTTS function
const pauseTTS = () => {
  if (speaking) {
      console.log('Pausing TTS');
      synth.pause();
      isPaused = true;
      speaking = false;
      
      const elapsedTime = currentUtterance ? currentUtterance.elapsedTime || 0 : 0;
      const estimatedPosition = Math.floor((elapsedTime / (currentUtterance?.duration || 1)) * sampleQuestion.length);
      pausedPosition = Math.max(estimatedPosition, 0);
      console.log('Paused at position:', pausedPosition);
      
      readQuestionButton.textContent = 'Resume Reading';
      
      // Update Firebase with paused state
      if (currentCallDoc) {
          currentCallDoc.update({
              ttsState: {
                  speaking: false,
                  isPaused: true,
                  wasSpeaking: true
              }
          }).catch(error => {
              console.error('Error updating TTS state:', error);
          });
      }
  }
};

// Modified resumeTTS function
const resumeTTS = () => {
  console.log('Attempting to resume TTS from position:', pausedPosition);
  if (isPaused) {
      try {
          readQuestion(pausedPosition);
          isPaused = false;
          readQuestionButton.textContent = 'Stop Reading';
          
          // Update Firebase with resumed state
          if (currentCallDoc) {
              currentCallDoc.update({
                  ttsState: {
                      speaking: true,
                      isPaused: false,
                      wasSpeaking: true
                  }
              }).catch(error => {
                  console.error('Error updating TTS state:', error);
              });
          }
      } catch (error) {
          console.error('Error resuming TTS:', error);
          speaking = false;
          isPaused = false;
          pausedPosition = 0;
          readQuestionButton.textContent = 'Read Question';
      }
  }
};

// Initialize Speech Recognition
const initializeSpeechRecognition = () => {
  if (!localCaptions || !remoteCaptions) {
      console.error('Captions containers not found:', {
          localCaptions: document.getElementById('localCaptions'),
          remoteCaptions: document.getElementById('remoteCaptions')
      });
      return;
  }

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
      console.error('Speech Recognition not supported in this browser');
      return;
  }

  try {
      recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      recognition.onstart = () => {
          console.log('Speech recognition started');
          localCaptions.textContent = 'Listening...';
          localCaptions.style.display = 'block';
          localCaptions.style.backgroundColor = 'rgba(76, 175, 80, 0.7)';
      };

      recognition.onresult = async (event) => {
          console.log('Speech recognition result received', {
              resultLength: event.results.length,
              isFinal: event.results[event.resultIndex].isFinal
          });

          let finalTranscript = '';
          let interimTranscript = '';

          for (let i = event.resultIndex; i < event.results.length; i++) {
              const transcript = event.results[i][0].transcript;
              if (event.results[i].isFinal) {
                  finalTranscript += transcript + ' ';
                  console.log('Final transcript:', finalTranscript);
                  
                  try {
                      // Validate answer with Gemini
                      const validation = await validateAnswer(sampleQuestion, finalTranscript.trim());
                      const formattedResult = formatValidationResult(validation);
                      
                      // Show answer status
                      showAnswerStatus(formattedResult.correct, formattedResult.explanation);
                      
                      // Update local captions with validation result
                      localCaptions.innerHTML = `
                          <span style="opacity: 1">${finalTranscript}</span>
                          <span style="color: ${formattedResult.style.color}; font-weight: ${formattedResult.style.fontWeight}">
                              (${formattedResult.message})
                          </span>
                      `;

                      // Update Firebase
                      if (currentCallDoc) {
                          await currentCallDoc.update({
                              captions: finalTranscript.trim(),
                              answerValidation: {
                                  answer: finalTranscript.trim(),
                                  isCorrect: formattedResult.correct,
                                  explanation: formattedResult.explanation
                              },
                              timestamp: Date.now()
                          });
                      }
                  } catch (error) {
                      console.error('Error during answer validation:', error);
                  }
              } else {
                  interimTranscript += transcript;
              }
          }

          // Show interim results while speaking
          if (interimTranscript) {
              localCaptions.innerHTML = `
                  <span style="opacity: 1">${finalTranscript}</span>
                  <span style="opacity: 0.7">${interimTranscript}</span>
              `;
          }
      };

      recognition.onerror = (event) => {
          console.error('Speech recognition error:', event.error);
          localCaptions.textContent = `Error: ${event.error}`;
          localCaptions.style.backgroundColor = 'rgba(244, 67, 54, 0.7)';

          if (event.error !== 'no-speech') {
              try {
                  recognition.stop();
                  setTimeout(() => {
                      recognition.start();
                      console.log('Recognition restarted after error');
                  }, 1000);
              } catch (e) {
                  console.error('Error restarting recognition:', e);
              }
          }
      };

      recognition.onend = () => {
          console.log('Speech recognition ended');
          localCaptions.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
          
          if (localStream && localStream.getAudioTracks()[0].enabled) {
              try {
                  recognition.start();
                  console.log('Recognition automatically restarted');
              } catch (e) {
                  console.error('Error restarting recognition after end:', e);
              }
          } else {
              localCaptions.textContent = '';
          }
      };

      console.log('Speech recognition initialized successfully');
  } catch (error) {
      console.error('Error initializing speech recognition:', error);
      localCaptions.textContent = 'Failed to initialize speech recognition';
  }
};

// Modified unmute timer function
const handleUnmuteTimer = async () => {
  if (isUnmuteButtonLocked || !localStream) {
      console.log('Unmute blocked:', { isUnmuteButtonLocked, hasLocalStream: !!localStream });
      return;
  }

  console.log('Starting unmute timer');
  
  const wasSpeaking = speaking || isPaused;
  
  try {
      // Immediately pause TTS if it's speaking
      if (speaking) {
          synth.cancel();
          speaking = false;
          isPaused = true;
          readQuestionButton.textContent = 'Read Question';
          console.log('TTS paused for unmute period');
      }

      // Update Firebase
      await currentCallDoc.update({
          buttonLocked: true,
          lastUnmuteTime: Date.now(),
          ttsState: {
              speaking: false,
              isPaused: true,
              wasSpeaking: wasSpeaking
          }
      });

      if (recognition) {
          recognition.stop();
          await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Enable audio track
      localStream.getAudioTracks().forEach(track => {
          track.enabled = true;
          console.log('Audio track enabled:', track.enabled);
      });

      if (recognition) {
          try {
              recognition.start();
              console.log('Recognition started for unmute period');
          } catch (e) {
              console.error('Error starting recognition during unmute:', e);
          }
      }

      let secondsLeft = 5;
      timerDisplay.style.display = 'block';
      timerDisplay.textContent = `Unmuted: ${secondsLeft}s`;

      const countdown = setInterval(() => {
          secondsLeft--;
          timerDisplay.textContent = `Unmuted: ${secondsLeft}s`;

          if (secondsLeft < 0) {
              clearInterval(countdown);
              timerDisplay.style.display = 'none';
              
              // Disable audio track
              localStream.getAudioTracks().forEach(track => {
                  track.enabled = false;
                  console.log('Audio track disabled');
              });

              if (recognition) {
                  recognition.stop();
                  console.log('Recognition stopped after unmute period');
              }

              // Update Firebase and resume TTS if needed
              currentCallDoc.update({
                  buttonLocked: false,
                  ttsState: {
                      speaking: false,
                      isPaused: false,
                      wasSpeaking: false
                  }
              }).then(() => {
                  if (wasSpeaking) {
                      setTimeout(() => {
                          console.log('Resuming TTS after unmute period');
                          readQuestion(0);
                      }, 500);
                  }
              });

              setTimeout(() => {
                  if (localCaptions) {
                      localCaptions.textContent = '';
                  }
                  currentCallDoc.update({
                      captions: ''
                  }).catch(error => {
                      console.error('Error clearing captions in Firebase:', error);
                  });
              }, 3000);
          }
      }, 1000);

      unmuteButton.disabled = true;
      setTimeout(() => {
          unmuteButton.disabled = false;
      }, 5000);

  } catch (error) {
      console.error('Error during unmute timer:', error);
      if (localCaptions) {
          localCaptions.textContent = 'Error during unmute';
      }
      unmuteButton.disabled = false;
  }
};


// Setup media sources
webcamButton.onclick = async () => {
    try {
        console.log("Attempting to get user media");
        localStream = await navigator.mediaDevices.getUserMedia({ 
            video: true, 
            audio: true 
        });
        console.log("Got local stream:", localStream);
        
        await initializeQuestionPool();
        initializeSpeechRecognition();
        
        localStream.getAudioTracks().forEach(track => {
          track.enabled = false;
      });
      
      remoteStream = new MediaStream();

      localStream.getTracks().forEach((track) => {
          pc.addTrack(track, localStream);
      });

      pc.ontrack = (event) => {
          event.streams[0].getTracks().forEach((track) => {
              remoteStream.addTrack(track);
          });
      };

      webcamVideo.srcObject = localStream;
      remoteVideo.srcObject = remoteStream;

      callButton.disabled = false;
      answerButton.disabled = false;
      webcamButton.disabled = true;
      unmuteButton.disabled = false;
      readQuestionButton.disabled = false;
  } catch (err) {
      console.error("Error accessing media devices:", err);
  }
};

// Setup shared snapshot handler
const setupCallDocSnapshot = (doc) => {
  doc.onSnapshot((snapshot) => {
      const data = snapshot.data();
      if (!data) return;

      isUnmuteButtonLocked = data.buttonLocked;
      unmuteButton.disabled = isUnmuteButtonLocked;
      
      // Handle TTS state changes from remote user
      if (data.buttonLocked) {  // Someone is unmuted
          if (speaking) {
              console.log('Remote user unmuted, pausing TTS');
              synth.cancel();
              speaking = false;
              isPaused = true;
              readQuestionButton.textContent = 'Read Question';
          }
      }
      
      // Handle unmute timer display
      if (data.buttonLocked) {
          const timeLeft = 5 - Math.floor((Date.now() - data.lastUnmuteTime) / 1000);
          if (timeLeft > 0) {
              timerDisplay.style.display = 'block';
              timerDisplay.textContent = `Unmuted: ${timeLeft}s`;
          } else {
              timerDisplay.style.display = 'none';
          }
      } else {
          timerDisplay.style.display = 'none';
      }
      
      // Handle captions
      const remoteCaptions = document.getElementById('remoteCaptions');
      if (data.captions) {
          remoteCaptions.textContent = data.captions;
      } else {
          remoteCaptions.textContent = '';
      }

      if (!pc.currentRemoteDescription && data.answer) {
          const answerDescription = new RTCSessionDescription(data.answer);
          pc.setRemoteDescription(answerDescription);
      }
  });
};

// Create a call
callButton.onclick = async () => {
  try {
      currentCallDoc = firestore.collection('calls').doc();
      const offerCandidates = currentCallDoc.collection('offerCandidates');
      const answerCandidates = currentCallDoc.collection('answerCandidates');

      callInput.value = currentCallDoc.id;

      await currentCallDoc.set({
          buttonLocked: false,
          lastUnmuteTime: null,
          captions: '',
          offer: null,
          ttsState: {
              speaking: false,
              isPaused: false,
              wasSpeaking: false
          }
      });

      setupCallDocSnapshot(currentCallDoc);

      pc.onicecandidate = (event) => {
          if (event.candidate) {
              console.log('Got caller candidate:', event.candidate);
              offerCandidates.add(event.candidate.toJSON());
          }
      };

      const offerDescription = await pc.createOffer();
      await pc.setLocalDescription(offerDescription);

      const offer = {
          sdp: offerDescription.sdp,
          type: offerDescription.type,
      };

      await currentCallDoc.update({ offer });

      answerCandidates.onSnapshot((snapshot) => {
          snapshot.docChanges().forEach((change) => {
              if (change.type === 'added') {
                  const candidate = new RTCIceCandidate(change.doc.data());
                  pc.addIceCandidate(candidate);
              }
          });
      });

      hangupButton.disabled = false;
  } catch (err) {
      console.error("Error during call setup:", err);
  }
};
// Answer the call
answerButton.onclick = async () => {
  try {
      const callId = callInput.value;
      currentCallDoc = firestore.collection('calls').doc(callId);
      const answerCandidates = currentCallDoc.collection('answerCandidates');
      const offerCandidates = currentCallDoc.collection('offerCandidates');

      setupCallDocSnapshot(currentCallDoc);

      pc.onicecandidate = (event) => {
          if (event.candidate) {
              answerCandidates.add(event.candidate.toJSON());
          }
      };

      const callData = (await currentCallDoc.get()).data();
      const offerDescription = callData.offer;
      await pc.setRemoteDescription(new RTCSessionDescription(offerDescription));

      const answerDescription = await pc.createAnswer();
      await pc.setLocalDescription(answerDescription);

      const answer = {
          type: answerDescription.type,
          sdp: answerDescription.sdp,
      };

      await currentCallDoc.update({ answer });

      offerCandidates.onSnapshot((snapshot) => {
          snapshot.docChanges().forEach((change) => {
              if (change.type === 'added') {
                  const data = change.doc.data();
                  pc.addIceCandidate(new RTCIceCandidate(data));
              }
          });
      });

      hangupButton.disabled = false;
  } catch (err) {
      console.error("Error during call answer:", err);
  }
};

// Add event listeners
unmuteButton.onclick = handleUnmuteTimer;

readQuestionButton.onclick = async () => {
  if (speaking || isPaused) {
      synth.cancel();
      speaking = false;
      isPaused = false;
      pausedPosition = 0;
      readQuestionButton.textContent = 'Read Question';
      
      // Update Firebase when stopping TTS
      if (currentCallDoc) {
          await currentCallDoc.update({
              ttsState: {
                  speaking: false,
                  isPaused: false,
                  wasSpeaking: false
              }
          });
      }
  } else if (!isUnmuteButtonLocked) {
      // Load new question and start reading
      await loadRandomQuestion();
      readQuestion(0);
  }
};

// Modified hangup function
hangupButton.onclick = async () => {
  try {
      if (speaking || isPaused) {
          synth.cancel();
          speaking = false;
          isPaused = false;
          pausedPosition = 0;
          readQuestionButton.textContent = 'Read Question';
      }
      if (recognition) {
          recognition.stop();
      }

      clearTimeout(recognitionTimeout);
      
      document.getElementById('localCaptions').textContent = '';
      document.getElementById('remoteCaptions').textContent = '';
      
      if (localStream) {
          localStream.getTracks().forEach(track => track.stop());
      }
      
      if (pc) {
          pc.close();
          pc = new RTCPeerConnection(servers);
      }

      if (currentCallDoc) {
          await currentCallDoc.update({
              buttonLocked: false,
              lastUnmuteTime: null,
              captions: ''
          });
      }

      webcamVideo.srcObject = null;
      remoteVideo.srcObject = null;
      localStream = null;
      remoteStream = null;
      currentCallDoc = null;

      // Reset question pool
      usedQuestionIds.clear();
      availableQuestionIds = [];

      webcamButton.disabled = false;
      callButton.disabled = true;
      answerButton.disabled = true;
      hangupButton.disabled = true;
      unmuteButton.disabled = true;
      readQuestionButton.disabled = true;
      timerDisplay.style.display = 'none';
      
      callInput.value = '';
  } catch (err) {
      console.error("Error during hangup:", err);
  }
};

// Connection state logging
pc.onconnectionstatechange = () => {
  console.log('Connection state:', pc.connectionState);
};

pc.oniceconnectionstatechange = () => {
  console.log('ICE connection state:', pc.iceConnectionState);
};

// Voice synthesis setup
window.speechSynthesis.onvoiceschanged = () => {
  const voices = synth.getVoices();
  console.log('Available voices:', voices.map(v => `${v.name} (${v.lang})`));
};

// Error handlers
webcamVideo.onerror = (err) => {
  console.error('Error with local video:', err);
};

remoteVideo.onerror = (err) => {
  console.error('Error with remote video:', err);
};

synth.onerror = (err) => {
  console.error('Speech synthesis error:', err);
};

// Initialize voices
window.speechSynthesis.onvoiceschanged = () => {
  const voices = synth.getVoices();
  console.log('Available voices:', voices.map(v => `${v.name} (${v.lang})`));
};