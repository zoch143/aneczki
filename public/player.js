const socket = io();
let hasAnswered = false;
let playerName = null;
let currentScore = 0;
let timerInterval = null;
let timeRemaining = 0;

function join() {
    playerName = document.getElementById("name").value.trim();
    if (!playerName) {
        alert('Please enter your name');
        return;
    }
    socket.emit("join", playerName);
    document.getElementById('name').disabled = true;
}

function send() {
    const answer = document.getElementById("answerInput").value.trim();
    if (!answer) {
        alert('Please enter an answer');
        return;
    }
    hasAnswered = true;
    document.getElementById('submitBtn').disabled = true;
    document.getElementById('answerInput').disabled = true;
    socket.emit("answer", { answer });
}

// Enter key support
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('name').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') join();
    });
    document.getElementById('answerInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !document.getElementById('submitBtn').disabled) send();
    });
});

socket.on('joinRejected', (data) => {
    alert(data.msg || 'Cannot join: game has already started');
    document.getElementById('name').disabled = false;
});

socket.on('gameStarted', (data) => {
    document.getElementById('joinArea').classList.add('hidden');
    document.getElementById('gameArea').classList.add('active');
});

socket.on('question', (q) => {
    const text = document.getElementById('questionText');
    text.textContent = q.question || '';
    hasAnswered = false;
    document.getElementById('answerInput').value = '';
    document.getElementById('submitBtn').disabled = false;
    document.getElementById('answerInput').disabled = false;
    document.getElementById('feedback').style.display = 'none';
    
    if (timerInterval) clearInterval(timerInterval);
    timeRemaining = q.timeLimit || 40;
    updatePlayerTimer();
});

socket.on('answerResult', (result) => {
    const feedback = document.getElementById('feedback');
    const msg = document.createElement('p');
    
    if (result.correct) {
        feedback.style.backgroundColor = '#fce7f3';
        feedback.style.color = '#be185d';
        msg.textContent = `✧ Correct! +${result.points} points (answered in ${Math.round(result.responseMs / 1000)}s)`;
    } else {
        feedback.style.backgroundColor = '#fef2f2';
        feedback.style.color = '#7c2d12';
        msg.textContent = `✦ Incorrect (answered in ${Math.round(result.responseMs / 1000)}s)`;
    }
    
    feedback.innerHTML = '';
    feedback.appendChild(msg);
    feedback.style.display = 'block';
});

socket.on('leaderboard', (scores) => {
    if (playerName && scores[playerName] !== undefined) {
        currentScore = scores[playerName];
        document.getElementById('playerScoreValue').textContent = currentScore;
    }
});

socket.on('timeUp', () => {
    if (timerInterval) clearInterval(timerInterval);
    document.getElementById('playerTimer').textContent = 'Time\'s up!';
    document.getElementById('submitBtn').disabled = true;
    document.getElementById('answerInput').disabled = true;
});

socket.on('allAnswered', () => {
    if (timerInterval) clearInterval(timerInterval);
    document.getElementById('playerTimer').textContent = 'All answered!';
    document.getElementById('submitBtn').disabled = true;
    document.getElementById('answerInput').disabled = true;
});

socket.on('gameEnded', () => {
    document.getElementById('joinArea').classList.remove('hidden');
    document.getElementById('gameArea').classList.remove('active');
    document.getElementById('name').disabled = false;
    document.getElementById('name').value = '';
    playerName = null;
    if (timerInterval) clearInterval(timerInterval);
});

function updatePlayerTimer() {
    const timerEl = document.getElementById('playerTimer');
    if (!timerEl) return;
    timerEl.textContent = timeRemaining + 's';
    
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        timeRemaining--;
        timerEl.textContent = timeRemaining + 's';
        if (timeRemaining <= 0) clearInterval(timerInterval);
    }, 1000);
}