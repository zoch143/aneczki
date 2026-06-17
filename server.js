const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

let rooms = {}; 
let socketToRoom = {}; 

function generateRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 4; i++) { code += chars[Math.floor(Math.random() * chars.length)]; }
    return code;
}

const uploadsDir = path.join(__dirname, 'uploads');
const mediaDir = path.join(__dirname, 'public', 'media');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

app.use(express.static("public"));

// Oczyszczanie wpisanej odpowiedzi gracza do porównania
function normalize(s) {
    return String(s || '')
        .replace(/<[^>]+>/g, '') 
        .replace(/[^\w\s]/g, '') 
        .replace(/\s+/g, ' ')    
        .trim()
        .toLowerCase();
}

function levenshtein(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            matrix[i][j] = b.charAt(i - 1) === a.charAt(j - 1) 
                ? matrix[i - 1][j - 1] 
                : Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
        }
    }
    return matrix[b.length][a.length];
}

function wordScore(given, expected) {
    const givenWords = new Set(given.split(" "));
    const expectedWords = expected.split(" ");
    let matchCount = 0;
    for (const word of expectedWords) { if (givenWords.has(word)) matchCount++; }
    return matchCount / expectedWords.length;
}

// 🎯 BEZBŁĘDNE WYCIĄGANIE NAZWY OBRAZKA ODPORNE NA "" Z ANKI
function extractImageSrc(html) {
    if (!html) return null;
    
    // Łapie zawartość src bez względu na liczbę cudzysłowów wokół
    const match = html.match(/src=\s*["']*(?:""|")?([^"'>]+)/i);
    if (match) {
        return match[1]
            .replace(/""/g, '')
            .replace(/["'>]/g, '')
            .toLowerCase()
            .replace(/ó/g, 'o')
            .replace(/ł/g, 'l')
            .replace(/ą/g, 'a')
            .replace(/ę/g, 'e')
            .replace(/ś/g, 's')
            .replace(/ź/g, 'z')
            .replace(/ż/g, 'z')
            .replace(/ć/g, 'c')
            .replace(/ń/g, 'n')
            .replace(/\s+/g, '_') // Zamienia spacje na "_" identycznie jak Twój PowerShell!
            .trim();
    }
    return null;
}

// GŁÓWNY SILNIK PARSOWANIA TALII TEKSTOWEJ
function parseTextFile(txtPath) {
    try {
        const content = fs.readFileSync(txtPath, 'utf8');
        const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const cards = [];

        for (const line of lines) {
            if (line.startsWith('#')) continue; 

            let parts = line.split('\t');
            if (parts.length < 2) continue;

            let frontSide = parts[0] || '';
            let backSide = parts[1] || '';

            // Wyciągamy idealnie dopasowaną do PowerShella nazwę zdjęcia
            const imageFile = extractImageSrc(frontSide) || extractImageSrc(backSide);

            // Odpowiedź na fiszkę zostaje w 100% naturalna (z pięknymi spacjami i dużymi literami)
            let question = frontSide.replace(/<[^>]+>/g, '').replace(/^["']|["']$/g, '').replace(/""/g, '"').trim();
            let answer = backSide.replace(/<[^>]+>/g, '').replace(/^["']|["']$/g, '').replace(/""/g, '"').trim();

            if (!question && imageFile) { question = "Co wskazuje szpilka? 🔬"; }
            console.log(`[DIAGNOSTYKA] Plik z TXT: "${imageFile}" | Czy istnieje na dysku? ${fs.existsSync(path.join(mediaDir, imageFile || ''))}`);
            if (answer) { cards.push({ id: null, question, answer, image: imageFile }); }
        }
        console.log(`[Anki Smart Engine] Załadowano ${cards.length} fiszek. Odpowiedzi są bezpieczne! 🌸`);
        return cards;
    } catch (err) { 
        console.error("Błąd parsowania pliku:", err);
        return []; 
    }
}

// ==========================================
// 🌐 ENDPOINTY HTTP
// ==========================================
app.get("/create-room", (req, res) => {
    const code = generateRoomCode();
    rooms[code] = { players: {}, scores: {}, currentDeck: [], gameActive: false, questionIndex: -1, currentQuestion: null, answersReceived: {}, questionTimer: null, questionTimeLimit: 30, gameMode: "classic" };
    console.log(`Stworzono pokoj: ${code}`);
    res.json({ roomCode: code });
});

app.post('/upload', upload.single('deck'), async (req, res) => {
    try {
        const roomCode = req.query.room;
        if (!roomCode || !rooms[roomCode]) return res.status(400).json({ success: false, msg: 'Nieprawidłowy kod pokoju' });
        if (!req.file) return res.status(400).json({ success: false, msg: 'Brak pliku' });
        rooms[roomCode].currentDeck = parseTextFile(req.file.path);
        return res.json({ success: true, count: rooms[roomCode].currentDeck.length });
    } catch (err) { return res.status(500).json({ success: false, msg: 'Błąd serwera' }); }
});

// ==========================================
// 🔌 LOGIKA SOCKET.IO
// ==========================================
io.on("connection", (socket) => {
    socket.on("join", ({ name, roomCode, avatar }) => {
        roomCode = (roomCode || '').toUpperCase();
        const room = rooms[roomCode];
        if (!room) { socket.emit('joinRejected', { msg: 'Pokój nie istnieje' }); return; }
        if (room.gameActive && name !== "Host") { socket.emit('joinRejected', { msg: 'Gra w tym pokoju już trwa' }); return; }

        socket.join(roomCode);
        socketToRoom[socket.id] = roomCode;
        
        if (name !== "Host") {
            room.players[socket.id] = { name, avatar: avatar || "🐮", streak: 0 };
            room.scores[name] = room.scores[name] || 0;
        } else {
            room.players[socket.id] = { name: "Host", avatar: "👑", streak: 0 };
        }

        const leaderboardData = Object.keys(room.scores).map(pName => {
            const pSocketId = Object.keys(room.players).find(id => room.players[id].name === pName);
            return { name: pName, score: room.scores[pName], avatar: pSocketId ? room.players[pSocketId].avatar : "🐮", streak: pSocketId ? room.players[pSocketId].streak : 0 };
        });

        io.to(roomCode).emit("leaderboard", leaderboardData);
        io.to(roomCode).emit('players', Object.keys(room.players).filter(id => room.players[id].name !== "Host").length);
    });

    socket.on("answer", (data) => {
        const roomCode = socketToRoom[socket.id];
        if (!roomCode || !rooms[roomCode]) return;
        
        const room = rooms[roomCode];
        const pData = room.players[socket.id];
        if (!pData || !room.gameActive || !room.currentQuestion || room.answersReceived[pData.name]) return;

        const answer = data && data.answer ? String(data.answer) : '';
        const responseMs = Date.now() - room.currentQuestion.startTime;
        const given = normalize(answer);
        const expected = normalize(room.currentQuestion.answer);

        let points = 0;
        let isPerfect = false;

        if (room.gameMode === "vocab") {
            const typos = levenshtein(given, expected);
            if (typos === 0 && given.length > 0) { points = 100 + Math.max(0, 100 - Math.floor(responseMs / 50)); isPerfect = true; } 
            else if (typos === 1) { points = 75 + Math.max(0, 75 - Math.floor(responseMs / 75)); } 
            else if (typos === 2) { points = 50 + Math.max(0, 50 - Math.floor(responseMs / 100)); } 
            else if (typos === 3) { points = 25 + Math.max(0, 25 - Math.floor(responseMs / 150)); }
        } else {
            if (expected && given === expected) { points = 100 + Math.max(0, 100 - Math.floor(responseMs / 50)); isPerfect = true; } 
            else if (expected && given) {
                const distance = levenshtein(given, expected);
                const similarity = 1 - (distance / Math.max(given.length, expected.length));
                if (similarity > 0.85) { points = Math.floor(75 + Math.max(0, 75 - Math.floor(responseMs / 75))); } 
                else {
                    const overlap = wordScore(given, expected);
                    if (overlap >= 0.3) { points = Math.floor(overlap * 60 + Math.max(0, 40 - Math.floor(responseMs / 100))); }
                }
            }
        }

        if (isPerfect) { pData.streak++; points += (pData.streak * 20); } else { pData.streak = 0; }
        room.answersReceived[pData.name] = true;
        if (points > 0) room.scores[pData.name] = (room.scores[pData.name] || 0) + points;

        socket.emit('answerResult', { correct: isPerfect || points > 0, isPerfect, points, responseMs, streak: pData.streak });

        const leaderboardData = Object.keys(room.scores).map(pName => {
            const pSocketId = Object.keys(room.players).find(id => room.players[id].name === pName);
            return { name: pName, score: room.scores[pName], avatar: pSocketId ? room.players[pSocketId].avatar : "🐮", streak: pSocketId ? room.players[pSocketId].streak : 0 };
        });

        io.to(roomCode).emit('leaderboard', leaderboardData);

        const totalPlayers = Object.values(room.players).filter(p => p.name !== "Host").length;
        const totalAnswers = Object.keys(room.answersReceived).filter(n => n !== "Host").length;
        io.to(roomCode).emit('answerProgress', { answered: totalAnswers, total: totalPlayers });

        if (totalPlayers > 0 && totalAnswers >= totalPlayers) {
            if (room.questionTimer) clearTimeout(room.questionTimer);
            io.to(roomCode).emit('allAnswered', { question: room.currentQuestion.question, answer: room.currentQuestion.answer });
            room.answersReceived = {};
        }
    });

    socket.on("leaveGame", () => { disconnectSocket(socket); });
    socket.on("disconnect", () => { disconnectSocket(socket); });

    socket.on('host:start', (data) => {
        const roomCode = socketToRoom[socket.id];
        const room = rooms[roomCode];
        if (!room || !room.currentDeck.length) { socket.emit('server:status', { ok: false, msg: 'Brak kart w pokoju!' }); return; }

        room.gameActive = true;
        room.questionIndex = -1;
        room.currentQuestion = null;
        room.answersReceived = {};
        room.questionTimeLimit = data && data.timeLimit ? Math.max(5, Math.min(300, parseInt(data.timeLimit))) : 30;
        room.gameMode = data && data.gameMode ? data.gameMode : "classic";

        let deckToPlay = [...room.currentDeck];
        for (let i = deckToPlay.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [deckToPlay[i], deckToPlay[j]] = [deckToPlay[j], deckToPlay[i]];
        }
        const maxQ = data && data.maxQuestions ? parseInt(data.maxQuestions) : 20;
        room.currentDeck = deckToPlay.slice(0, maxQ);

        io.to(roomCode).emit('gameStarted', { timeLimit: room.questionTimeLimit });
    });

    socket.on('host:next', () => {
        const roomCode = socketToRoom[socket.id];
        const room = rooms[roomCode];
        if (!room || !room.gameActive || !room.currentDeck.length) return;

        if (room.questionIndex + 1 >= room.currentDeck.length) {
            if (room.questionTimer) clearTimeout(room.questionTimer);
            room.gameActive = false;
            sendFinalLeaderboard(roomCode);
            return;
        }

        if (room.questionTimer) clearTimeout(room.questionTimer);
        room.questionIndex++;
        const card = room.currentDeck[room.questionIndex];
        
        room.currentQuestion = { id: null, question: card.question, answer: card.answer, image: card.image, startTime: Date.now() };
        room.answersReceived = {};

        const totalPlayers = Object.values(room.players).filter(p => p.name !== "Host").length;
        io.to(roomCode).emit('answerProgress', { answered: 0, total: totalPlayers });
        
        io.to(roomCode).emit('question', { 
            question: room.currentQuestion.question, 
            index: room.questionIndex, 
            totalCards: room.currentDeck.length, 
            timeLimit: room.questionTimeLimit,
            image: room.currentQuestion.image 
        });

        room.questionTimer = setTimeout(() => {
            io.to(roomCode).emit('timeUp', { question: room.currentQuestion.question, answer: room.currentQuestion.answer });
            room.answersReceived = {};
        }, room.questionTimeLimit * 1000);
    });

    socket.on('host:stop', () => {
        const roomCode = socketToRoom[socket.id];
        const room = rooms[roomCode];
        if (!room || !room.gameActive || !room.currentQuestion) return;
        if (room.questionTimer) clearTimeout(room.questionTimer);
        io.to(roomCode).emit('timeUp', { question: room.currentQuestion.question, answer: room.currentQuestion.answer });
        room.answersReceived = {}; 
    });

    socket.on('host:endGame', () => {
        const roomCode = socketToRoom[socket.id];
        if (roomCode) sendFinalLeaderboard(roomCode);
    });
});

function disconnectSocket(socket) {
    const roomCode = socketToRoom[socket.id];
    if (roomCode && rooms[roomCode]) {
        const room = rooms[roomCode];
        const pData = room.players[socket.id];
        if (pData) { delete room.players[socket.id]; if (pData.name !== "Host") delete room.scores[pData.name]; }
        delete socketToRoom[socket.id];

        const leaderboardData = Object.keys(room.scores).map(pName => {
            const pSocketId = Object.keys(room.players).find(id => room.players[id].name === pName);
            return { name: pName, score: room.scores[pName], avatar: pSocketId ? room.players[pSocketId].avatar : "🐮", streak: pSocketId ? room.players[pSocketId].streak : 0 };
        });
        io.to(roomCode).emit("leaderboard", leaderboardData);
        io.to(roomCode).emit('players', Object.keys(room.players).filter(id => room.players[id].name !== "Host").length);
        if (Object.keys(room.players).length === 0) { if (room.questionTimer) clearTimeout(room.questionTimer); delete rooms[roomCode]; }
    }
}

function sendFinalLeaderboard(roomCode) {
    const room = rooms[roomCode]; if (!room) return; room.gameActive = false;
    const finalData = Object.keys(room.scores).map(pName => {
        const pSocketId = Object.keys(room.players).find(id => room.players[id].name === pName);
        return { name: pName, score: room.scores[pName], avatar: pSocketId ? room.players[pSocketId].avatar : "🐮" };
    });
    io.to(roomCode).emit('gameEnded', finalData);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serwer Anki Smart Engine działa na porcie ${PORT} 🚀`));