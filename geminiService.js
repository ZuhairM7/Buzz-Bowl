// geminiService.js
require('dotenv').config();

// Function to validate answer with Gemini
export async function validateAnswer(question, userAnswer) {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    const GEMINI_API_URL = process.env.GEMINI_API_URL;
    
    const prompt = `Question: '${question}'
    Player's answer: '${userAnswer}'

    Based on the question and the player's answer, determine if the answer is correct according to the following rules:
    1. Accept answers that include key parts or concepts relevant to the correct answer, even if they are not complete.
    2. Accept minor phrasing differences or synonyms that convey the same meaning.
    3. Consider the answer correct if it sounds phonetically similar or if it partially matches the answer conceptually.

    Respond with 'Correct' if the player's answer meets these criteria, or 'Incorrect' if it does not. Provide an explanation if possible.`;

    try {
        const response = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                contents: [{
                    parts: [{
                        text: prompt
                    }]
                }]
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        const result = data.candidates[0].content.parts[0].text;
        
        return {
            isCorrect: result.includes('Correct'),
            explanation: result,
            raw: result
        };
    } catch (error) {
        console.error('Error validating with Gemini:', error);
        throw error;
    }
}

// Optional: Function to format the validation result for display
export function formatValidationResult(validationResult) {
    return {
        correct: validationResult.isCorrect,
        message: validationResult.isCorrect ? 'Correct!' : 'Incorrect',
        explanation: validationResult.explanation,
        style: {
            color: validationResult.isCorrect ? '#4CAF50' : '#f44336',
            fontWeight: 'bold'
        }
    };
}