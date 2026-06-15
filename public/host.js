const socket = io();
let gameStarted = false;
let timerInterval = null;
let timeRemaining = 0;
let connectedPlayers = 0;

socket.on("leaderboard", (scores) => {
    const board = document.getElementById("board");
    board.innerHTML = "";
    let hasScores = false;
    for (let name in scores) {
        hasScores = true;
        const p = document.createElement("p");
        p.textContent = `♡ ${name}: ${scores[name]} pts`;
        board.appendChild(p);
    }
    if (!hasScores) {
        board.innerHTML = '<p style="color:#a78bfa; font-style:italic;">waiting for players...</p>';
    }
});

socket.on('question', (q) => {
    const el = document.getElementById('currentQuestion');
    el.textContent = q.question || '';
    
    if (timerInterval) clearInterval(timerInterval);
    timeRemaining = q.timeLimit || 40;
    updateTimer();
    
    document.getElementById('correctAnswer').style.display = 'none';
    document.getElementById('correctAnswer').innerHTML = '';
});

socket.on('gameStarted', (data) => {
    gameStarted = true;
    document.getElementById('preGameArea').classList.add('hidden');
    document.getElementById('gameArea').classList.add('active');
});

socket.on('server:status', (s) => {
    const el = document.getElementById('gameStatus');
    if (!s) return;
    el.textContent = s.msg || (s.ok ? '✓' : '✗');
    el.style.color = s.ok ? '#10b981' : '#ef4444';
});

socket.on('players', (count) => {
    connectedPlayers = count;
    const el = document.getElementById('playerCount');
    if (!el) return;
    el.textContent = `★ ${count} player${count !== 1 ? 's' : ''} connected`;
});

socket.on('timeUp', (data) => {
    if (timerInterval) clearInterval(timerInterval);
    document.getElementById('timer').textContent = 'Time\'s up!';
    
    const correctDiv = document.getElementById('correctAnswer');
    correctDiv.innerHTML = `<strong>✧ Correct Answer:</strong> ${data.answer}`;
    correctDiv.style.display = 'block';
});

socket.on('allAnswered', (data) => {
    if (timerInterval) clearInterval(timerInterval);
    document.getElementById('timer').textContent = 'All answered!';
    
    const correctDiv = document.getElementById('correctAnswer');
    correctDiv.innerHTML = `<strong>✧ Correct Answer:</strong> ${data.answer}`;
    correctDiv.style.display = 'block';
});

function updateTimer() {
    const timerEl = document.getElementById('timer');
    timerEl.textContent = timeRemaining + 's';
    
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        timeRemaining--;
        timerEl.textContent = timeRemaining + 's';
        if (timeRemaining <= 0) clearInterval(timerInterval);
    }, 1000);
}

async function uploadDeck() {
    const input = document.getElementById('deckFile');
    const status = document.getElementById('uploadStatus');
    if (!input.files || !input.files[0]) {
        status.textContent = '✗ No file selected';
        return;
    }
    const file = input.files[0];
    status.textContent = '⋅ Uploading...';
    const form = new FormData();
    form.append('deck', file);
    try {
        const url = window.location.origin + '/upload';
        const res = await fetch(url, { method: 'POST', body: form });
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch (e) { /* not JSON */ }
        if (!res.ok) {
            const msg = data && data.msg ? data.msg : `${res.status} ${res.statusText}`;
            status.textContent = `✗ ${msg}`;
            return;
        }
        if (data && data.success) {
            status.textContent = `✓ ${data.filename} (${data.count} cards)`;
        } else {
            status.textContent = data && data.msg ? `✗ ${data.msg}` : `✗ Upload failed`;
        }
    } catch (err) {
        status.textContent = `✗ ${err.message}`;
    }
}

function startGame() {
    const timeLimit = parseInt(document.getElementById('timeLimit').value) || 40;
    socket.emit('host:start', { timeLimit });
}

function nextQuestion() {
    socket.emit('host:next');
}

function clearLeaderboard() {
    if (confirm('Clear all scores? This cannot be undone.')) {
        socket.emit('host:clearScores');
        document.getElementById('gameStatus').textContent = '✓ Leaderboard cleared';
        document.getElementById('gameStatus').style.color = '#10b981';
    }
}

function goBackToSetup() {
    if (confirm('End game and return to setup?')) {
        socket.emit('host:endGame');
        gameStarted = false;
        document.getElementById('preGameArea').classList.remove('hidden');
        document.getElementById('gameArea').classList.remove('active');
        if (timerInterval) clearInterval(timerInterval);
    }
}

// Enter key support
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('timeLimit').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') startGame();
    });
});
