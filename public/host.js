const socket = io();
let myRoomCode = "";
let gameStarted = false;
let timerInterval = null;
let timeRemaining = 0;
let connectedPlayers = 0;

document.addEventListener('DOMContentLoaded', () => {
    fetch("/create-room")
        .then(res => res.json())
        .then(data => {
            myRoomCode = data.roomCode;
            const displayEl = document.getElementById("roomCodeDisplay");
            if (displayEl) displayEl.textContent = myRoomCode;
            socket.emit("join", { name: "Host", roomCode: myRoomCode });
        })
        .catch(err => console.error(err));
});

socket.on("leaderboard", (playersList) => {
    const board = document.getElementById("board");
    if (!board) return;
    board.innerHTML = "";
    let hasScores = false;
    
    playersList.sort((a, b) => b.score - a.score);

    for (let p of playersList) {
        if (p.name === "Host") continue;
        hasScores = true;
        
        const row = document.createElement("div");
        row.className = "leaderboard-row";
        const streakTag = p.streak >= 2 ? `<span class="p-streak">🔥 ${p.streak}</span>` : "";
        
        row.innerHTML = `
            <div class="p-meta">
                <span>${p.avatar}</span>
                <span class="player-name">${p.name}</span>
                ${streakTag}
            </div>
            <span class="player-score">${p.score} pts</span>
        `;
        board.appendChild(row);
    }
    if (!hasScores) {
        board.innerHTML = '<p style="color:#a855f7; font-style:italic; text-align:center;">(｡•́︿•̀｡) waiting for players...</p>';
    }
});

socket.on('question', (q) => {
    const el = document.getElementById('currentQuestion');
    if (el) el.textContent = q.question || '';
    
    const imgContainer = document.getElementById('qImageContainer');
    const imgTag = document.getElementById('qImage');
    
    if (q.image) {
    // Ładujemy czysty plik z serwera za pomocą adresu URL
    imgTag.src = window.location.origin + "/media/" + q.image;
    if (imgContainer) imgContainer.style.display = "block";
} else {
    if (imgContainer) imgContainer.style.display = "none";
    imgTag.removeAttribute('src'); 
}

    const stopBtn = document.getElementById('stopBtn');
    if (stopBtn) stopBtn.disabled = false;

    if (timerInterval) clearInterval(timerInterval);
    timeRemaining = q.timeLimit || 40;
    
    const timerEl = document.getElementById('timer');
    if (timerEl) {
        timerEl.classList.remove('timer-low');
        timerEl.textContent = timeRemaining + 's';
    }
    updateTimer();
    
    const correctDiv = document.getElementById('correctAnswer');
    if (correctDiv) { correctDiv.style.display = 'none'; correctDiv.innerHTML = ''; }
});

socket.on('answerProgress', (data) => {
    const badge = document.getElementById('progressBadge');
    if (badge) badge.textContent = `🌸 ${data.answered}/${data.total} answered`;
});

socket.on('gameStarted', (data) => {
    gameStarted = true;
    document.getElementById('preGameArea').classList.add('hidden');
    document.getElementById('gameArea').classList.add('active');
});

socket.on('players', (count) => {
    const realPlayersCount = Math.max(0, count - 1);
    connectedPlayers = realPlayersCount;
    const el = document.getElementById('playerCount');
    if (!el) return;
    el.textContent = `٩(◕‿◕)۶ ${realPlayersCount} player${realPlayersCount !== 1 ? 's' : ''} connected`;
});

socket.on('timeUp', (data) => {
    if (data && data.answer) revealAnswerAndStopTimer(data.answer, "(｡>﹏<｡) Time's up!");
});

socket.on('allAnswered', (data) => {
    if (data && data.answer) revealAnswerAndStopTimer(data.answer, "＼(≧▽≦)／ All clear!");
});

function revealAnswerAndStopTimer(answer, statusText) {
    if (timerInterval) clearInterval(timerInterval);
    const timerEl = document.getElementById('timer');
    if (timerEl) { timerEl.textContent = statusText; timerEl.classList.remove('timer-low'); }
    const stopBtn = document.getElementById('stopBtn');
    if (stopBtn) stopBtn.disabled = true;

    const correctDiv = document.getElementById('correctAnswer');
    if (correctDiv) {
        correctDiv.innerHTML = `<small>✦ (〃▽〃) Correct Answer ✦</small><div>${answer}</div>`;
        correctDiv.style.display = 'block';
    }
}

function updateTimer() {
    const timerEl = document.getElementById('timer');
    if (!timerEl) return;
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        timeRemaining--;
        timerEl.textContent = timeRemaining + 's';
        if (timeRemaining <= 5 && timeRemaining > 0) { timerEl.classList.add('timer-low'); }
        if (timeRemaining <= 0) { clearInterval(timerInterval); }
    }, 1000);
}

function startGame() {
    const timeLimitInput = document.getElementById('timeLimit');
    const gameModeInput = document.getElementById('gameMode');
    const maxQuestionsInput = document.getElementById('maxQuestions');
    
    const timeLimit = timeLimitInput ? (parseInt(timeLimitInput.value) || 40) : 40;
    const gameMode = gameModeInput ? gameModeInput.value : "classic";
    const maxQuestions = maxQuestionsInput ? (parseInt(maxQuestionsInput.value) || 20) : 20;
    
    socket.emit('host:start', { timeLimit, gameMode, maxQuestions });
}

function uploadDeck() {
    const input = document.getElementById('deckFile');
    const status = document.getElementById('uploadStatus');
    if (!input || !input.files || !input.files[0]) { if (status) status.textContent = '✗ No file selected'; return; }
    const file = input.files[0];
    if (status) status.textContent = '⋅ Uploading...';
    const form = new FormData();
    form.append('deck', file);
    fetch(`${window.location.origin}/upload?room=${myRoomCode}`, { method: 'POST', body: form })
        .then(res => res.json())
        .then(data => {
            if (data.success) status.textContent = `✓ ${file.name} (${data.count} cards)`;
            else status.textContent = `✗ Upload failed`;
        }).catch(err => { if (status) status.textContent = `✗ ${err.message}`; });
}

function stopQuestion() { socket.emit('host:stop'); }
function nextQuestion() { socket.emit('host:next'); }
function forceEndGame() { if (confirm('Zakończyć grę i pokazać podium?')) { socket.emit('host:endGame'); } }

socket.on('gameEnded', (sortedData) => {
    if (timerInterval) clearInterval(timerInterval);
    document.getElementById('gameArea').style.display = 'none';
    document.getElementById('endGameArea').classList.add('active');

    const podiumVisual = document.getElementById('podiumVisual');
    const finalFullLeaderboard = document.getElementById('finalFullLeaderboard');
    
    podiumVisual.innerHTML = "";
    finalFullLeaderboard.innerHTML = "<h3>📊 Full scoreboard:</h3><br>";

    const top1 = sortedData[0]; const top2 = sortedData[1]; const top3 = sortedData[2];

    if (top2) { podiumVisual.innerHTML += `<div class="podium-block podium-2"><div class="p-name">🥈 ${top2.avatar} ${top2.name}</div><div class="p-score">${top2.score} pts</div><div class="p-rank">2</div></div>`; }
    if (top1) { podiumVisual.innerHTML += `<div class="podium-block podium-1"><div class="p-name">👑 ${top1.avatar} ${top1.name}</div><div class="p-score">${top1.score} pts</div><div class="p-rank">1</div></div>`; }
    if (top3) { podiumVisual.innerHTML += `<div class="podium-block podium-3"><div class="p-name">🥉 ${top3.avatar} ${top3.name}</div><div class="p-score">${top3.score} pts</div><div class="p-rank">3</div></div>`; }

    if (sortedData.length === 0) { podiumVisual.innerHTML = "<p>(｡•́︿•̀｡) No player data.</p>"; } 
    else { sortedData.forEach((p, idx) => { finalFullLeaderboard.innerHTML += `<p><b>#${idx + 1}</b> ${p.avatar} ${p.name} — ${p.score} pts</p>`; }); }
});