// =============================================================
// WHACK-A-MOLE MULTIPLAYER SERVER
// Node.js + ws — serves game page + WebSocket on one port
// =============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const METERED_API_KEY = process.env.METERED_API_KEY || '';
const METERED_APP_NAME = process.env.METERED_APP_NAME || '';

// ---------- HTTP server (serves index.html + TURN credentials API) ----------
const server = http.createServer((req, res) => {
    // API endpoint for TURN credentials
    if (req.url === '/api/turn-credentials') {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');

        if (!METERED_API_KEY || !METERED_APP_NAME) {
            console.log('TURN: No API key or app name set, returning STUN only. METERED_API_KEY:', METERED_API_KEY ? 'SET' : 'MISSING', 'METERED_APP_NAME:', METERED_APP_NAME ? METERED_APP_NAME : 'MISSING');
            res.writeHead(200);
            res.end(JSON.stringify([
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ]));
            return;
        }

        // Fetch TURN credentials from Metered.ca
        const apiUrl = `https://${METERED_APP_NAME}.metered.live/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`;
        console.log('TURN: Fetching credentials from:', apiUrl.replace(METERED_API_KEY, '***'));
        const https = require('https');
        https.get(apiUrl, (apiRes) => {
            let body = '';
            apiRes.on('data', chunk => body += chunk);
            apiRes.on('end', () => {
                console.log('TURN: API response status:', apiRes.statusCode, 'body length:', body.length);
                try {
                    const creds = JSON.parse(body);
                    console.log('TURN: Got', creds.length, 'TURN servers from Metered');
                    // Add STUN servers too
                    const iceServers = [
                        { urls: 'stun:stun.l.google.com:19302' },
                        { urls: 'stun:stun1.l.google.com:19302' },
                        ...creds
                    ];
                    res.writeHead(200);
                    res.end(JSON.stringify(iceServers));
                } catch (e) {
                    console.error('TURN API parse error:', e, 'Body:', body);
                    res.writeHead(200);
                    res.end(JSON.stringify([
                        { urls: 'stun:stun.l.google.com:19302' },
                        { urls: 'stun:stun1.l.google.com:19302' }
                    ]));
                }
            });
        }).on('error', (e) => {
            console.error('TURN API fetch error:', e);
            res.writeHead(200);
            res.end(JSON.stringify([
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ]));
        });
        return;
    }

    // Serve static files
    let filePath = req.url === '/' ? '/index.html' : req.url;
    filePath = path.join(__dirname, filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mime = {
        '.html': 'text/html', '.js': 'application/javascript',
        '.css': 'text/css', '.json': 'application/json',
        '.png': 'image/png', '.svg': 'image/svg+xml'
    };
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
        res.end(data);
    });
});

// ---------- WebSocket server ----------
const wss = new WebSocketServer({ server });

// Room storage: code -> Room
const rooms = new Map();

function genCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
    let code;
    do { code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
    while (rooms.has(code));
    return code;
}

const MOLE_TYPES = ['normal', 'helmet', 'danger'];
const HOLE_COUNT = 7;
const GAME_DURATION = 60; // 1 minute

class Room {
    constructor(hostWs) {
        this.code = genCode();
        this.host = hostWs;
        this.guest = null;
        this.scores = { host: 0, guest: 0 };
        this.holes = new Array(HOLE_COUNT).fill(null); // null or { type, spawnedAt }
        this.gameActive = false;
        this.spawnTimer = null;
        this.diffTimer = null;
        this.gameTimer = null;
        this.timeLeft = GAME_DURATION;
        this.gameStartTime = 0;
        this.minSpawn = 1;
        this.maxSpawn = 3;
        this.dangerChance = 0.2;
        this.tutorialPhase = 0;
        this.helmetHits = new Map(); // holeIndex -> { host: hits, guest: hits }
    }

    broadcast(msg) {
        const data = JSON.stringify(msg);
        if (this.host && this.host.readyState === 1) this.host.send(data);
        if (this.guest && this.guest.readyState === 1) this.guest.send(data);
    }

    sendTo(ws, msg) {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
    }

    startGame() {
        this.gameActive = true;
        this.scores = { host: 0, guest: 0 };
        this.timeLeft = GAME_DURATION;
        this.holes.fill(null);
        this.helmetHits.clear();
        this.gameStartTime = Date.now();
        this.minSpawn = 1;
        this.maxSpawn = 3;
        this.dangerChance = 0.2;
        this.tutorialPhase = 0;

        this.sendTo(this.host, { type: 'game_start', role: 'host' });
        this.sendTo(this.guest, { type: 'game_start', role: 'guest' });

        // Tutorial phases
        setTimeout(() => { if (this.gameActive) this.tutorialPhase = 1; }, 10000);
        setTimeout(() => { if (this.gameActive) this.tutorialPhase = 2; }, 25000);

        // Difficulty ramp
        this.diffTimer = setInterval(() => {
            if (!this.gameActive) return;
            this.minSpawn = Math.max(0.5, this.minSpawn - 0.1);
            this.maxSpawn = Math.max(1, this.maxSpawn - 0.15);
            if (this.maxSpawn < this.minSpawn + 0.1) this.maxSpawn = this.minSpawn + 0.1;
            this.dangerChance = Math.min(0.4, this.dangerChance + 0.02);
        }, 15000);

        // Game timer - 1 minute countdown
        this.gameTimer = setInterval(() => {
            if (!this.gameActive) return;
            this.timeLeft--;
            this.broadcast({ type: 'timer_sync', timeLeft: this.timeLeft });
            if (this.timeLeft <= 0) {
                this.endGame();
            }
        }, 1000);

        this.scheduleSpawn();
    }

    scheduleSpawn() {
        if (!this.gameActive) return;
        const delay = (this.minSpawn + Math.random() * (this.maxSpawn - this.minSpawn)) * 1000;
        this.spawnTimer = setTimeout(() => {
            if (!this.gameActive) return;
            this.doSpawn();
            this.scheduleSpawn();
        }, delay);
    }

    doSpawn() {
        const empties = [];
        for (let i = 0; i < HOLE_COUNT; i++) { if (!this.holes[i]) empties.push(i); }
        if (!empties.length) return;
        const idx = empties[Math.floor(Math.random() * empties.length)];
        const r = Math.random();
        let type;
        if (this.tutorialPhase === 0) {
            type = 'normal';
        } else if (this.tutorialPhase === 1) {
            type = r < 0.5 ? 'normal' : 'helmet';
        } else {
            if (r < this.dangerChance) type = 'danger';
            else type = r < 0.55 ? 'normal' : 'helmet';
        }

        this.holes[idx] = { type, spawnedAt: Date.now() };
        if (type === 'helmet') this.helmetHits.set(idx, { host: 0, guest: 0 });

        const duration = type === 'danger' ? 2500 : (1500 + Math.random() * 1500);
        this.broadcast({ type: 'spawn_mole', index: idx, moleType: type });

        // Auto-hide after duration
        setTimeout(() => {
            if (this.holes[idx] && this.holes[idx].spawnedAt === this.holes[idx].spawnedAt) {
                this.holes[idx] = null;
                this.broadcast({ type: 'hide_mole', index: idx });
            }
        }, duration);
    }

    handleWhack(ws, holeIndex) {
        if (!this.gameActive) return;
        const role = ws === this.host ? 'host' : 'guest';
        const hole = this.holes[holeIndex];
        if (!hole) return;

        const type = hole.type;
        let points = 0;
        let consumed = false;

        if (type === 'normal') {
            points = 10;
            consumed = true;
        } else if (type === 'helmet') {
            const hits = this.helmetHits.get(holeIndex) || { host: 0, guest: 0 };
            hits[role]++;
            this.helmetHits.set(holeIndex, hits);
            const totalHits = hits[role];
            if (totalHits === 1) {
                points = 10;
                // Broadcast damaged state
                this.broadcast({ type: 'helmet_damaged', index: holeIndex });
            } else {
                points = 20;
                consumed = true;
            }
        } else if (type === 'danger') {
            // Lose points instead of lives
            points = -5;
            consumed = true;
        }

        if (points !== 0) {
            this.scores[role] += points;
            this.broadcast({
                type: 'score_update',
                scores: this.scores,
                whacker: role,
                holeIndex,
                points,
                moleType: type
            });
        }

        if (consumed) {
            this.holes[holeIndex] = null;
            this.broadcast({ type: 'hide_mole', index: holeIndex, whacker: role });
        }
    }

    endGame() {
        this.gameActive = false;
        if (this.spawnTimer) clearTimeout(this.spawnTimer);
        if (this.diffTimer) clearInterval(this.diffTimer);
        if (this.gameTimer) clearInterval(this.gameTimer);
        const winner = this.scores.host > this.scores.guest ? 'host' : (this.scores.guest > this.scores.host ? 'guest' : 'tie');
        this.broadcast({
            type: 'game_over',
            scores: this.scores,
            timeLeft: this.timeLeft,
            winner
        });
    }

    handleDisconnect(ws) {
        const role = ws === this.host ? 'host' : 'guest';
        if (this.gameActive) {
            this.endGame();
        }
        const other = role === 'host' ? this.guest : this.host;
        if (other && other.readyState === 1) {
            this.sendTo(other, { type: 'opponent_disconnected' });
        }
        rooms.delete(this.code);
    }
}

// ---------- Connection handler ----------
wss.on('connection', (ws) => {
    let myRoom = null;

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        switch (msg.type) {
            case 'create_room': {
                const room = new Room(ws);
                rooms.set(room.code, room);
                myRoom = room;
                ws.send(JSON.stringify({ type: 'room_created', code: room.code }));
                console.log(`Room ${room.code} created`);
                break;
            }
            case 'join_room': {
                const code = (msg.code || '').toUpperCase();
                const room = rooms.get(code);
                if (!room) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
                    return;
                }
                if (room.guest) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Room is full' }));
                    return;
                }
                room.guest = ws;
                myRoom = room;
                ws.send(JSON.stringify({ type: 'room_joined', code }));
                // Notify host
                room.sendTo(room.host, { type: 'opponent_joined' });
                console.log(`Player joined room ${code}`);
                // Start game after brief countdown
                setTimeout(() => { if (room.host && room.guest) room.startGame(); }, 3000);
                break;
            }
            case 'whack': {
                if (myRoom) myRoom.handleWhack(ws, msg.index);
                break;
            }
            case 'hand_pos': {
                // Relay hand positions to the opponent
                if (!myRoom) return;
                const other = ws === myRoom.host ? myRoom.guest : myRoom.host;
                if (other && other.readyState === 1) {
                    other.send(JSON.stringify({
                        type: 'opponent_hands',
                        positions: msg.positions
                    }));
                }
                break;
            }
            case 'signal': {
                // Relay WebRTC signaling (offer, answer, ice-candidate)
                if (!myRoom) return;
                const other = ws === myRoom.host ? myRoom.guest : myRoom.host;
                if (other && other.readyState === 1) {
                    other.send(JSON.stringify({
                        type: 'signal',
                        data: msg.data
                    }));
                }
                break;
            }
            case 'start_bot': {
                // Host requests a bot game — server acts as the guest
                if (myRoom && !myRoom.guest) {
                    // Mark bot mode — guest is null but game starts
                    myRoom.botMode = true;
                    myRoom.sendTo(myRoom.host, { type: 'bot_activated' });
                    setTimeout(() => {
                        if (myRoom) {
                            // Start game in single-player with server-side spawning
                            myRoom.gameActive = true;
                            myRoom.scores = { host: 0, guest: 0 };
                            myRoom.timeLeft = GAME_DURATION;
                            myRoom.holes.fill(null);
                            myRoom.helmetHits.clear();
                            myRoom.gameStartTime = Date.now();
                            myRoom.minSpawn = 1;
                            myRoom.maxSpawn = 3;
                            myRoom.dangerChance = 0.2;
                            myRoom.tutorialPhase = 0;

                            myRoom.sendTo(myRoom.host, { type: 'game_start', role: 'host' });

                            // Tutorial phases
                            setTimeout(() => { if (myRoom && myRoom.gameActive) myRoom.tutorialPhase = 1; }, 10000);
                            setTimeout(() => { if (myRoom && myRoom.gameActive) myRoom.tutorialPhase = 2; }, 25000);

                            // Difficulty ramp
                            myRoom.diffTimer = setInterval(() => {
                                if (!myRoom || !myRoom.gameActive) return;
                                myRoom.minSpawn = Math.max(0.5, myRoom.minSpawn - 0.1);
                                myRoom.maxSpawn = Math.max(1, myRoom.maxSpawn - 0.15);
                                if (myRoom.maxSpawn < myRoom.minSpawn + 0.1) myRoom.maxSpawn = myRoom.minSpawn + 0.1;
                                myRoom.dangerChance = Math.min(0.4, myRoom.dangerChance + 0.02);
                            }, 15000);

                            // Game timer
                            myRoom.gameTimer = setInterval(() => {
                                if (!myRoom || !myRoom.gameActive) return;
                                myRoom.timeLeft--;
                                myRoom.broadcast({ type: 'timer_sync', timeLeft: myRoom.timeLeft });
                                if (myRoom.timeLeft <= 0) {
                                    myRoom.endGame();
                                }
                            }, 1000);

                            myRoom.scheduleSpawn();

                            // Bot AI loop
                            startBotAI(myRoom);
                        }
                    }, 2000);
                }
                break;
            }
        }
    });

    ws.on('close', () => {
        if (myRoom) myRoom.handleDisconnect(ws);
    });
});

// ---------- Bot AI ----------
function startBotAI(room) {
    const botLoop = setInterval(() => {
        if (!room || !room.gameActive) { clearInterval(botLoop); return; }

        // Find occupied holes
        const occupied = [];
        for (let i = 0; i < HOLE_COUNT; i++) {
            if (room.holes[i]) occupied.push(i);
        }
        if (!occupied.length) return;

        // Bot decides whether to whack (80% chance each tick)
        if (Math.random() < 0.8) {
            const target = occupied[Math.floor(Math.random() * occupied.length)];
            const hole = room.holes[target];
            if (!hole) return;

            // Bot avoids danger moles most of the time (90%)
            if (hole.type === 'danger' && Math.random() < 0.9) return;

            // Simulate bot whack
            const type = hole.type;
            let points = 0;
            let consumed = false;

            if (type === 'normal') {
                points = 10; consumed = true;
            } else if (type === 'helmet') {
                const hits = room.helmetHits.get(target) || { host: 0, guest: 0 };
                hits.guest++;
                room.helmetHits.set(target, hits);
                if (hits.guest === 1) {
                    points = 10;
                    room.broadcast({ type: 'helmet_damaged', index: target });
                } else {
                    points = 20; consumed = true;
                }
            } else if (type === 'danger') {
                points = -5;
                consumed = true;
            }

            if (points !== 0) {
                room.scores.guest += points;
                room.broadcast({
                    type: 'score_update',
                    scores: room.scores,
                    whacker: 'guest',
                    holeIndex: target,
                    points,
                    moleType: type
                });
            }
            if (consumed) {
                room.holes[target] = null;
                room.broadcast({ type: 'hide_mole', index: target, whacker: 'guest' });
            }

            // Send bot hand position toward the target barrel
            const BARREL_POS = [
                [0.08, 0.28], [0.08, 0.62],
                [0.92, 0.28], [0.92, 0.62],
                [0.25, 0.82], [0.50, 0.85], [0.75, 0.82]
            ];
            const bp = BARREL_POS[target];
            room.sendTo(room.host, {
                type: 'opponent_hands',
                positions: [
                    { x: bp[0] - 0.05 + Math.random() * 0.1, y: bp[1] - 0.05 + Math.random() * 0.1 },
                    { x: bp[0] - 0.05 + Math.random() * 0.1, y: bp[1] - 0.05 + Math.random() * 0.1 }
                ]
            });
        }
    }, 600 + Math.random() * 600); // 600-1200ms between bot actions
}

// ---------- Start ----------
server.listen(PORT, () => {
    console.log(`\n🔨 Whack-a-Mole Multiplayer Server`);
    console.log(`   http://localhost:${PORT}`);
    console.log(`   WebSocket ready on same port\n`);
});
