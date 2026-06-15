const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const AdmZip = require('adm-zip');
const initSqlJs = require('sql.js');
let SQL = null;
initSqlJs().then((mod) => { SQL = mod; }).catch(err => { console.error('sql.js init failed', err); });

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// log incoming HTTP requests for debugging
app.use((req, res, next) => {
    console.log(new Date().toISOString(), req.method, req.url);
    next();
});

// simple health endpoint
app.get('/status', (req, res) => res.json({ ok: true }));

// serve static files (we’ll add pages later)
app.use(express.static("public"));

// ensure uploads dir exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadsDir);
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ storage });

let players = {};
let scores = {};
let currentDeckPath = null;
let currentDeck = [];
let gameActive = false;
let questionIndex = -1;
let currentQuestion = null; // { id, question, answer, startTime }
let answersReceived = {}; // name -> true
let questionTimeLimit = 30; // seconds
let questionTimer = null;

async function parseApkg(apkgPath) {
    try {
        if (!SQL) {
            SQL = await initSqlJs();
        }
        const zip = new AdmZip(apkgPath);
        const entries = zip.getEntries();
        const collEntry = entries.find(e => e.entryName.includes('collection') && e.entryName.endsWith('.anki2'))
            || entries.find(e => e.entryName === 'collection.anki2')
            || entries.find(e => e.entryName.includes('collection'));

        if (!collEntry) {
            console.warn('No collection file found inside apkg');
            return [];
        }

        const buf = collEntry.getData();
        const uint8 = new Uint8Array(buf);
        const db = new SQL.Database(uint8);
        const res = db.exec('SELECT id, flds FROM notes');
        const cards = [];
        if (res.length && res[0].values) {
            for (const v of res[0].values) {
                const id = v[0];
                const flds = v[1] || '';
                const fields = flds.split('\x1f');
                const question = (fields[0] || '').replace(/\r|\n/g, ' ').trim();
                const answer = (fields[1] || '').replace(/\r|\n/g, ' ').trim();
                if (question) cards.push({ id, question, answer });
            }
        }
        try { if (db.close) db.close(); } catch (e) {}

        // Filter out image-occlusion and cloze-type cards (skip if they contain images or cloze markers)
        const filtered = cards.filter(c => {
            const q = (c.question || '').toLowerCase();
            const a = (c.answer || '').toLowerCase();
            if (!c.question) return false;
            if (q.includes('<img') || a.includes('<img')) return false;
            if (q.includes('occlusion') || a.includes('occlusion') || q.includes('image occlusion') || a.includes('image occlusion')) return false;
            if (q.includes('{{c') || a.includes('{{c') || q.includes('cloze') || a.includes('cloze')) return false;
            return true;
        });

        console.log(`Cards found: ${cards.length}, after filter: ${filtered.length}`);
        return filtered;
    } catch (err) {
        console.error('Failed to parse apkg:', err);
        return [];
    }
}

function parseTextFile(txtPath) {
    try {
        const content = fs.readFileSync(txtPath, 'utf8');
        const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const cards = [];
        const separators = ['|||','---','—',':::', '::','->','=>',' ||| ',' // ','|',' - ',' — ',';',' ; '];
        for (const line of lines) {
            // Anki plain text export uses tab-separated fields (front\tback\t...)
            const parts = line.split('\t');
            let question = (parts[0] || '').replace(/\r|\n/g, ' ').trim();
            let answer = (parts[1] || '').replace(/\r|\n/g, ' ').trim();

            // Heuristic: if answer missing and question contains a separator, split it
            if (!answer) {
                for (const sep of separators) {
                    if (question.includes(sep)) {
                        const [left, right] = question.split(sep);
                        if ((left || '').trim() && (right || '').trim()) {
                            question = left.trim();
                            answer = right.trim();
                            break;
                        }
                    }
                }
            }

            // remove simple labels like 'Answer:' from question if present
            question = question.replace(/^question\s*[:\-\s]+/i, '').trim();
            answer = answer.replace(/^answer\s*[:\-\s]+/i, '').trim();

            if (question) cards.push({ id: null, question, answer });
        }
        console.log(`Parsed text file with ${cards.length} cards`);
        return cards;
    } catch (err) {
        console.error('Failed to parse text file:', err);
        return [];
    }
}

// upload endpoint for host to send a deck file
app.post('/upload', upload.single('deck'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, msg: 'No file uploaded' });
        currentDeckPath = req.file.path;
        console.log('Deck uploaded:', req.file.path);
        // attempt to parse the uploaded file
        const name = (req.file.originalname || '').toLowerCase();
        if (name.endsWith('.txt') || name.endsWith('.csv')) {
            currentDeck = parseTextFile(currentDeckPath);
        } else if (name.endsWith('.apkg') || name.endsWith('.colpkg') || name.endsWith('.zip')) {
            currentDeck = await parseApkg(currentDeckPath);
        } else {
            // try apkg parse as fallback
            currentDeck = await parseApkg(currentDeckPath);
        }
        console.log(`Parsed ${currentDeck.length} cards`);
        return res.json({ success: true, filename: req.file.originalname, count: currentDeck.length });
    } catch (err) {
        console.error('Upload handler error:', err && err.stack ? err.stack : err);
        return res.status(500).json({ success: false, msg: 'Server error during upload', err: String(err) });
    }
});

io.on("connection", (socket) => {

    console.log("A user connected:", socket.id);

    // broadcast current player count for UI
    io.emit('players', Object.keys(players).length);

    // when someone joins
    socket.on("join", (name) => {
        if (gameActive) {
            socket.emit('joinRejected', { msg: 'Game has already started' });
            return;
        }
        players[socket.id] = name;
        scores[name] = scores[name] || 0;

        io.emit("leaderboard", scores);
        io.emit('players', Object.keys(players).length);
    });

    // when someone sends an answer
    socket.on("answer", (data) => {
        const name = players[socket.id];
        if (!name) return;
        if (!gameActive || !currentQuestion) return;
        if (answersReceived[name]) return; // ignore multiple answers
        const answer = (data && data.answer) ? String(data.answer) : '';
        const receivedAt = Date.now();
        const responseMs = receivedAt - currentQuestion.startTime;

        function normalize(s) {
            return String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
        }

        function levenshtein(a, b) {
            if (a.length === 0) return b.length;
            if (b.length === 0) return a.length;
            const matrix = [];
            for (let i = 0; i <= b.length; i++) matrix[i] = [i];
            for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
            for (let i = 1; i <= b.length; i++) {
                for (let j = 1; j <= a.length; j++) {
                    if (b.charAt(i - 1) === a.charAt(j - 1)) {
                        matrix[i][j] = matrix[i - 1][j - 1];
                    } else {
                        matrix[i][j] = Math.min(
                            matrix[i - 1][j - 1] + 1,
                            matrix[i][j - 1] + 1,
                            matrix[i - 1][j] + 1
                        );
                    }
                }
            }
            return matrix[b.length][a.length];
        }

        const given = normalize(answer);
        const expected = normalize(currentQuestion.answer);

        let points = 0;
        let correct = false;

        if (expected && given === expected) {
            // Perfect match: base 100, time bonus scales with speed (max +100 for <5s)
            const timeBonus = Math.max(0, 100 - Math.floor(responseMs / 50));
            points = 100 + timeBonus;
            correct = true;
        } else if (expected && given) {
            const distance = levenshtein(given, expected);
            const similarity = 1 - (distance / Math.max(given.length, expected.length));
            
            // Allow up to 2 character typos if similarity > 0.85
            if (similarity > 0.85) {
                const timeBonus = Math.max(0, 75 - Math.floor(responseMs / 75));
                points = Math.floor(75 + timeBonus);
                correct = true;
            } else if (expected.includes(given) || given.includes(expected)) {
                // Partial match
                const timeBonus = Math.max(0, 40 - Math.floor(responseMs / 100));
                points = Math.max(1, 40 + timeBonus);
                correct = true;
            }
        }

        answersReceived[name] = true;
        if (points > 0) {
            scores[name] = (scores[name] || 0) + points;
        }

        // acknowledge to player (don't send expected answer to players)
        socket.emit('answerResult', { correct, points, responseMs });

        // update leaderboard
        io.emit('leaderboard', scores);
        console.log(`Answer from ${name}: "${answer}" -> ${points} pts (expected: "${currentQuestion.answer}")`);
        
        // Check if all connected players have answered
        const playersCount = Object.keys(players).length;
        const answeredCount = Object.keys(answersReceived).length;
        console.log(`Answers received: ${answeredCount}/${playersCount}`);
        
        if (playersCount > 0 && answeredCount >= playersCount) {
            console.log('All players answered!');
            if (questionTimer) clearTimeout(questionTimer);
            io.emit('allAnswered', { question: currentQuestion.question, answer: currentQuestion.answer });
            answersReceived = {};
        }
    });

    // host gives points manually (for now)
    socket.on("addPoint", (name) => {
        scores[name] = (scores[name] || 0) + 1;
        io.emit("leaderboard", scores);
    });

    socket.on("disconnect", () => {
        delete players[socket.id];
        io.emit('players', Object.keys(players).length);
    });
    // host controls
    socket.on('host:start', (data) => {
        console.log('Received host:start from', socket.id);
        if (!currentDeck || !currentDeck.length) {
            console.log('host:start rejected - no deck loaded');
            socket.emit('server:status', { ok: false, msg: 'No deck loaded' });
            return;
        }
        gameActive = true;
        questionIndex = -1;
        currentQuestion = null;
        answersReceived = {};
        
        // Set time limit from host input
        if (data && data.timeLimit) {
            questionTimeLimit = Math.max(5, Math.min(300, parseInt(data.timeLimit) || 30));
        } else {
            questionTimeLimit = 30;
        }
        
        io.emit('gameStarted', { timeLimit: questionTimeLimit });
        socket.emit('server:status', { ok: true, msg: 'Game started' });
        console.log('Game started by host with', questionTimeLimit, 'sec per question');
    });

    socket.on('host:next', () => {
        console.log('Received host:next from', socket.id);
        if (!gameActive) {
            socket.emit('server:status', { ok: false, msg: 'Game not active. Click Start first.' });
            console.log('host:next rejected - game not active');
            return;
        }
        if (!currentDeck || !currentDeck.length) {
            socket.emit('server:status', { ok: false, msg: 'No cards available' });
            console.log('host:next rejected - no cards');
            return;
        }
        
        // Clear previous timer
        if (questionTimer) clearTimeout(questionTimer);
        
        questionIndex = (questionIndex + 1) % currentDeck.length;
        const card = currentDeck[questionIndex];
        const startTime = Date.now();
        currentQuestion = { id: card.id, question: card.question, answer: card.answer, startTime };
        answersReceived = {};
        
        io.emit('question', { question: currentQuestion.question, index: questionIndex, timeLimit: questionTimeLimit });
        socket.emit('server:status', { ok: true, msg: `Question ${questionIndex} sent` });
        console.log(`Broadcasted question ${questionIndex}`);
        
        // Auto-close answers and emit result after time limit
        questionTimer = setTimeout(() => {
            console.log('Time up for question', questionIndex);
            io.emit('timeUp', { question: currentQuestion.question, answer: currentQuestion.answer });
            answersReceived = {}; // Reset so no more answers accepted
        }, questionTimeLimit * 1000);
    });

    socket.on('host:clearScores', () => {
        console.log('Clearing leaderboard');
        scores = {};
        Object.keys(players).forEach(pid => {
            const name = players[pid];
            scores[name] = 0;
        });
        io.emit('leaderboard', scores);
    });

    socket.on('host:endGame', () => {
        console.log('Game ended by host');
        gameActive = false;
        if (questionTimer) clearTimeout(questionTimer);
        io.emit('gameEnded');
    });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`Server running on ${PORT}`);
});