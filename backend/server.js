const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();

const path = require('path');

// Questo dice a Node di salire di un livello (..) e cercare la cartella dist del frontend
// NOTA: Se la tua cartella del frontend si chiama "frontend", scrivi '../frontend/dist'
const distPath = path.join(__dirname, '../frontend/dist');

app.use(express.static(distPath));

app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
});

// ⚠️ In produzione sostituisci "*" con il tuo dominio reale, es:
// const ALLOWED_ORIGIN = "https://tuodominio.com";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*"; // "*" va bene SOLO in sviluppo

app.use(cors({ origin: ALLOWED_ORIGIN }));

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGIN,
    methods: ["GET", "POST"]
  }
});

// Database temporaneo in memoria per i "Nest" attivi
// Struttura: { "123456": { adminId, users: [{id, name}], timer } }
const activeNests = {};

const ALLOWED_TTL_MINUTES = [5, 10, 15];
const VALID_PIN_REGEX = /^[A-Z0-9]{6}$/;
const MAX_ACTIVE_NESTS = 500; // tetto anti-esaurimento risorse

function generateSecurePin() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let pin = '';
    for (let i = 0; i < 6; i++) {
        pin += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return pin;
}

// ---------------------------------------------------------
// RATE LIMITING per IP (in-memory: se in futuro scali su più
// istanze del server, sposta questi contatori su Redis)
// ---------------------------------------------------------
const rateBuckets = new Map(); // ip -> { count, resetAt }

function isRateLimited(ip, max, windowMs) {
    const now = Date.now();
    const bucket = rateBuckets.get(ip) || { count: 0, resetAt: now + windowMs };
    if (now > bucket.resetAt) {
        bucket.count = 0;
        bucket.resetAt = now + windowMs;
    }
    bucket.count++;
    rateBuckets.set(ip, bucket);
    return bucket.count > max;
}

// pulizia periodica per non far crescere la Map all'infinito
setInterval(() => {
    const now = Date.now();
    for (const [ip, bucket] of rateBuckets.entries()) {
        if (now > bucket.resetAt) rateBuckets.delete(ip);
    }
}, 5 * 60000);

// ---------------------------------------------------------
// Helpers centralizzati per distruzione/pulizia dei nest
// (riusati sia da leave_nest che da disconnect)
// ---------------------------------------------------------
function destroyNest(pin, reason) {
    const room = activeNests[pin];
    if (!room) return;
    clearTimeout(room.timer);
    io.to(pin).emit('nest_destroyed', { message: reason });
    io.socketsLeave(pin);
    delete activeNests[pin];
    console.log(`[DESTROY] Nest ${pin} distrutto (${reason})`);
}

function removeUserFromNest(pin, socketId) {
    const room = activeNests[pin];
    if (!room) return;
    if (room.adminId === socketId) {
        // SECURE OVERRIDE: se l'admin se ne va (anche per crash/disconnessione), il nest muore
        destroyNest(pin, "L'amministratore ha chiuso il Nest. Sei stato disconnesso.");
    } else {
        room.users = room.users.filter(u => u.id !== socketId);
        console.log(`[INFO] Utente ${socketId} rimosso dal Nest ${pin}`);
    }
}

// Verifica che il socket target appartenga allo STESSO nest del socket mittente
function sameNest(senderSocket, targetId) {
    const pin = senderSocket.data.pin;
    if (!pin || !activeNests[pin]) return false;
    return activeNests[pin].users.some(u => u.id === targetId);
}

io.on('connection', (socket) => {
    console.log(`[+] Nuovo dispositivo connesso: ${socket.id}`);

    // ==========================================
    // CREAZIONE NEST (con PIN personalizzato opzionale)
    // ==========================================
    socket.on('create_nest', (data) => {
    try {
        const ip = socket.handshake.address;
        if (isRateLimited(ip, 5, 60000)) {
            return socket.emit('error', { message: 'Troppi nest creati, riprova tra un minuto.' });
        }
        if (Object.keys(activeNests).length >= MAX_ACTIVE_NESTS) {
            return socket.emit('error', { message: 'Servizio momentaneamente saturo, riprova più tardi.' });
        }

        const ttlMinutes = ALLOWED_TTL_MINUTES.includes(data?.ttl) ? data.ttl : 10;

        let pin;
        const customPin = typeof data?.customPin === 'string' ? data.customPin.toUpperCase() : null;

        if (customPin && VALID_PIN_REGEX.test(customPin) && !activeNests[customPin]) {
            pin = customPin;
        } else {
            do { pin = generateSecurePin(); } while (activeNests[pin]);
        }

        // NUOVO: validiamo e salviamo il nome del nest
        const roomTitle = typeof data?.nestName === 'string' && data.nestName.trim()
            ? data.nestName.trim().slice(0, 60)
            : 'Pigeon Nest';

        activeNests[pin] = {
            adminId: socket.id,
            users: [{ id: socket.id, name: 'Admin' }],
            roomTitle, // NUOVO
            timer: setTimeout(() => destroyNest(pin, 'Il Nest si è autodistrutto.'), ttlMinutes * 60000)
        };

        socket.data.pin = pin;
        socket.join(pin);
        socket.emit('nest_created_success', { pin, ttl: ttlMinutes });
        console.log(`[CREATE] Nest ${pin} creato (TTL: ${ttlMinutes}m)`);
    } catch (err) {
        console.error('Errore in create_nest:', err);
        socket.emit('error', { message: 'Errore interno, riprova.' });
    }
});

    // ==========================================
    // UTENTE ENTRA IN UNA STANZA
    // ==========================================
    socket.on('join_nest', (data) => {
        try {
            const ip = socket.handshake.address;
            if (isRateLimited(ip, 15, 60000)) {
                return socket.emit('error', { message: 'Troppi tentativi, riprova tra un minuto.' });
            }
            if (typeof data?.pin !== 'string' || !VALID_PIN_REGEX.test(data.pin.toUpperCase())) {
                return socket.emit('error', { message: 'PIN non valido.' });
            }

            const pin = data.pin.toUpperCase();
            const userName = typeof data?.userName === 'string' && data.userName.trim()
                ? data.userName.trim().slice(0, 30)
                : 'Pigeon';
            const room = activeNests[pin];

            if (!room) {
                return socket.emit('error', { message: 'Nest non trovato o autodistrutto.' });
            }

            socket.data.pin = pin; // <-- fondamentale: lega questo socket al nest
            socket.join(pin);
            room.users.push({ id: socket.id, name: userName });

            console.log(`[JOIN] ${userName} (${socket.id}) è entrato nel Nest ${pin}`);

            // Avvisa l'ADMIN che un nuovo dispositivo è pronto
            socket.to(room.adminId).emit('device_joined', { id: socket.id, name: userName });

            // Risponde all'utente confermando l'ingresso
            socket.emit('join_success', { pin, adminId: room.adminId, roomTitle: room.roomTitle }); // NUOVO: aggiunto roomTitle
        } catch (err) {
            console.error('Errore in join_nest:', err);
            socket.emit('error', { message: 'Errore interno, riprova.' });
        }
    });

    // ==========================================
    // SEGNALAZIONE WEBRTC — ORA VINCOLATA AL NEST
    // ==========================================
    // Topologia a stella: SOLO l'admin può inviare un'offerta,
    // e ogni messaggio è valido solo tra membri dello STESSO nest.

    socket.on('webrtc_offer', (data) => {
        try {
            const pin = socket.data.pin;
            const room = pin && activeNests[pin];
            if (!room || room.adminId !== socket.id) return; // solo l'admin inizia una connessione
            if (!sameNest(socket, data?.targetId)) return;   // il target deve essere nello stesso nest

            socket.to(data.targetId).emit('webrtc_offer', { sdp: data.sdp, senderId: socket.id });
        } catch (err) {
            console.error('Errore in webrtc_offer:', err);
        }
    });

    socket.on('webrtc_answer', (data) => {
        try {
            if (!sameNest(socket, data?.targetId)) return;
            const room = activeNests[socket.data.pin];
            if (room.adminId !== data.targetId) return; // la risposta torna SOLO verso l'admin

            socket.to(data.targetId).emit('webrtc_answer', { sdp: data.sdp, senderId: socket.id });
        } catch (err) {
            console.error('Errore in webrtc_answer:', err);
        }
    });

    socket.on('webrtc_ice_candidate', (data) => {
        try {
            if (!sameNest(socket, data?.targetId)) return;
            socket.to(data.targetId).emit('webrtc_ice_candidate', { candidate: data.candidate, senderId: socket.id });
        } catch (err) {
            console.error('Errore in webrtc_ice_candidate:', err);
        }
    });

    // ==========================================
    // ADMIN RIMUOVE UN UTENTE (KICK)
    // ==========================================
    socket.on('kick_user', (data) => {
        try {
            const pin = socket.data.pin;
            const room = pin && activeNests[pin];
            if (!room || room.adminId !== socket.id) return; // solo l'admin del PROPRIO nest può espellere
            if (typeof data?.userId !== 'string') return;

            const targetSocket = io.sockets.sockets.get(data.userId);
            if (targetSocket) {
                targetSocket.emit('kicked_by_admin');
                targetSocket.leave(pin);
                targetSocket.data.pin = null;
            }
            room.users = room.users.filter(u => u.id !== data.userId); // fix: allinea lo stato interno
            console.log(`[KICK] L'admin ha rimosso ${data.userId} dal Nest ${pin}`);
        } catch (err) {
            console.error('Errore in kick_user:', err);
        }
    });

    // ==========================================
    // USCITA VOLONTARIA DAL NEST
    // ==========================================
    socket.on('leave_nest', (data) => {
        try {
            const pin = socket.data.pin || data?.pin;
            if (pin) removeUserFromNest(pin, socket.id);
            socket.data.pin = null;
        } catch (err) {
            console.error('Errore in leave_nest:', err);
        }
    });

    // ==========================================
    // DISCONNESSIONE (chiusura tab, crash di rete, ecc.)
    // Prima era vuota: ora la stanza viene ripulita comunque.
    // ==========================================
    socket.on('disconnect', () => {
        console.log(`[-] Dispositivo disconnesso: ${socket.id}`);
        const pin = socket.data.pin;
        if (pin) removeUserFromNest(pin, socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server Signaling avviato sulla porta ${PORT}`);
    console.log(`📡 In attesa di connessioni...`);
});