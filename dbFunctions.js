// database.js
export function getData() {
    const tableName = "QuizBowl.DB2";

    return fetch('https://c14f-140-82-220-240.ngrok-free.app/getall', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ tableName: tableName }),
    })
    .then(response => response.json())  // Parse as JSON instead of text
    .catch((error) => {
        console.error('Error:', error);
        throw error;
    });
}

export function getDataById(recordId) {
    const tableName = "QuizBowl.DB2"
  
    return fetch("https://c14f-140-82-220-240.ngrok-free.app/getbyid", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ tableName: tableName, id: recordId }),
    })
    .then((response) => response.json())
    .catch((error) => {
        console.error("Error:", error);
        throw error;
    });
}