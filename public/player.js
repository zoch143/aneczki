const socket = io();
let hasAnswered = false;
let playerName = null;
let currentScore = 0;
let timerInterval = null;
let timeRemaining = 0;
let selectedAvatar = "🐮";

function selectAvatar(element, emoji) {
    document.querySelectorAll('.avatar-opt').forEach(el => el.classList.remove('selected'));
    element.classList.add('selected');
    selectedAvatar = emoji;
}

function join() {
    playerName = document.getElementById("name").value.trim();
    const roomCode = document.getElementById("roomCode").value.trim();
    
    if (!playerName) { alert('Please enter your name'); return; }
    if (!roomCode) { alert('Please enter the room code'); return; }
    
    socket.emit("join", { name: playerName, roomCode: roomCode, avatar: selectedAvatar });
    document.getElementById('name').disabled = true;
    document.getElementById('roomCode').disabled = true;
}

function send() {
    const answer = document.getElementById("answerInput").value.trim();
    if (!answer) { alert('Please enter an answer'); return; }
    hasAnswered = true;
    document.getElementById('submitBtn').disabled = true;
    document.getElementById('answerInput').disabled = true;
    socket.emit("answer", { answer });
}

function leaveMatch() {
    if (confirm("Chcesz opuścić ten pokój? Wynik zostanie skasowany.")) {
        socket.emit("leaveGame");
        window.location.reload();
    }
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('name').addEventListener('keypress', (e) => { if (e.key === 'Enter') join(); });
    document.getElementById('roomCode').addEventListener('keypress', (e) => { if (e.key === 'Enter') join(); });
    document.getElementById('answerInput').addEventListener('keypress', (e) => { if (e.key === 'Enter' && !document.getElementById('submitBtn').disabled) send(); });
});

socket.on('joinRejected', (data) => {
    alert(data.msg || 'Cannot join');
    document.getElementById('name').disabled = false;
    document.getElementById('roomCode').disabled = false;
});

socket.on('gameStarted', (data) => {
    document.getElementById('joinArea').classList.add('hidden');
    document.getElementById('gameArea').classList.add('active');
});

socket.on('question', (q) => {
    const text = document.getElementById('questionText');
    if (text) text.textContent = q.question || '';
    
    const imgContainer = document.getElementById('pImgContainer');
    const imgTag = document.getElementById('pImg');
    
   if (q.image) {
    // Ładujemy czysty plik z serwera za pomocą adresu URL
    imgTag.src = window.location.origin + "/media/" + q.image;
    if (imgContainer) imgContainer.style.display = "block";
} else {
    if (imgContainer) imgContainer.style.display = "none";
    imgTag.removeAttribute('src');
}

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
    if (!feedback) return;
    const streakMsg = result.streak >= 2 ? `<br>🔥 Streak x${result.streak}! (+${result.streak * 20} bonus pts!)` : "";

    if (result.isPerfect) {
        feedback.style.backgroundColor = '#d1fae5';
        feedback.style.color = '#065f46';
        feedback.innerHTML = `＼(≧▽≦)／ Perfect 100%! +${result.points} pts ${streakMsg}`;
    } else if (result.correct) {
        feedback.style.backgroundColor = '#fef3c7';
        feedback.style.color = '#92400e';
        feedback.innerHTML = `✧ Close! Good enough: +${result.points} pts (Streak reset 🌸)`;
    } else {
        feedback.style.backgroundColor = '#fee2e2';
        feedback.style.color = '#991b1b';
        feedback.innerHTML = `✦ (｡•́︿•̀｡) Incorrect! +0 pts (Streak reset 🌸)`;
    }
    feedback.style.display = 'block';
});

socket.on('leaderboard', (playersList) => {
    if (playerName) {
        const me = playersList.find(p => p.name === playerName);
        if (me) {
            currentScore = me.score;
            document.getElementById('playerScoreValue').textContent = currentScore;
        }
    }
});

socket.on('timeUp', () => {
    if (timerInterval) clearInterval(timerInterval);
    document.getElementById('playerTimer').textContent = "Time's up!";
    document.getElementById('submitBtn').disabled = true;
    document.getElementById('answerInput').disabled = true;
});

socket.on('allAnswered', () => {
    if (timerInterval) clearInterval(timerInterval);
    document.getElementById('playerTimer').textContent = 'All clear!';
    document.getElementById('submitBtn').disabled = true;
    document.getElementById('answerInput').disabled = true;
});

socket.on('gameEnded', (sortedData) => {
    if (timerInterval) clearInterval(timerInterval);
    const myIndex = sortedData.findIndex(p => p.name === playerName);
    const myRank = myIndex !== -1 ? myIndex + 1 : "???";

    const gameArea = document.getElementById('gameArea');
    if (gameArea) {
        gameArea.innerHTML = `
            <h1 style="font-size: 2.2rem; color:#db2777; margin-bottom:20px;">👑 MATCH FINISHED! 👑</h1>
            <p style="font-size: 1.4rem; color:#581c87; margin-bottom: 25px;">Final Score: <b>${currentScore} pts</b></p>
            <div style="background:#fff5f8; padding: 25px; border-radius:20px; font-size:1.8rem; font-weight:bold; color:#db2777; border: 3px dashed #fbcfe8;">
                🏆 Final Rank: #${myRank}
            </div>
            <p style="margin-top: 35px; font-style:italic; color:#a855f7;">(っ•ᴗ•)っ Poczekaj na kolejny pokój Hosta!</p>
        `;
    }
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