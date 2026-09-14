import React, { useState, useEffect, useRef } from 'react';
import { Settings, LogIn, Plus, Folder, ArrowLeft, ArrowRight, Copy, X, Send, Check, Paperclip, Download } from 'lucide-react';
import { io } from 'socket.io-client';

// Se usiamo Vite (porta 5173) usa l'IP locale, altrimenti (su internet/tunnel) usa l'indirizzo automatico
const isDev = window.location.port === '5173';
const socket = io(isDev ? 'http://192.168.1.11:3000' : undefined);

// FIX: limite massimo di dimensione file accettato, per evitare di mandare in crisi
// la memoria del dispositivo ricevente (adegua il valore alle tue esigenze reali).
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB

// FIX: ogni quanti chunk "comprimiamo" il buffer di ricezione in un unico Blob
// intermedio, per non arrivare mai ad assemblare migliaia di pezzi tutti insieme
// in un solo colpo sincrono.
const BLOB_MERGE_EVERY_N_CHUNKS = 200;

// FIX: se non c'è alcun progresso di trasferimento per questo tempo, consideriamo
// il trasferimento bloccato e lo annulliamo automaticamente.
const STALL_TIMEOUT_MS = 20000;




// FEAT: formatta una dimensione in byte in una stringa leggibile (es. "128 MB"),
// usata nella tabella mostrata dal pulsante "Get info".
function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(size >= 10 ? 0 : 2)} ${units[unitIndex]}`;
}

const CustomToggle = ({ isOn, onToggle }) => (
  <div
    onClick={onToggle}
    className={`w-14 h-8 rounded-full flex items-center p-1 cursor-pointer transition-colors duration-300 ${isOn ? 'bg-[#308333]' : 'bg-[#7B1919]'}`}
  >
    <div className={`bg-white w-6 h-6 rounded-full shadow-md transform transition-transform duration-300 flex items-center justify-center ${isOn ? 'translate-x-6' : 'translate-x-0'}`}>
      <span className={`text-xs font-bold ${isOn ? 'text-[#308333]' : 'text-[#7B1919]'}`}>
        {isOn ? 'I' : 'O'}
      </span>
    </div>
  </div>
);

// FIX: Error Boundary — se un errore imprevisto sfugge, invece di far sparire
// tutta l'interfaccia in una schermata nera muta, mostriamo un messaggio e un
// modo per recuperare.
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error, info) {
    console.error('Errore catturato dall\'Error Boundary:', error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-black text-white flex items-center justify-center p-6 text-center">
          <div>
            <p className="mb-4">Si è verificato un errore imprevisto.</p>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-[#2958C2] rounded-lg"
            >
              Ricarica l'app
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function AppContent() {
  const [currentPage, setCurrentPage] = useState('home');
  const [toggle5Min, setToggle5Min] = useState(false);
  const [toggle15Min, setToggle15Min] = useState(false);

  const [roomPin, setRoomPin] = useState('...');
  const [createPin, setCreatePin] = useState(['', '', '', '', '', '']);
  const [joinPin, setJoinPin] = useState(['', '', '', '', '', '']);
  const [userName, setUserName] = useState('');

  // --- STATI E REF PER WEBRTC ---
  const pcRef = useRef(null);
  const dcRef = useRef(null);
  const [connectionStatus, setConnectionStatus] = useState('In attesa...');
  const [messages, setMessages] = useState([]);
  const [textInput, setTextInput] = useState('');
  const [isCopied, setIsCopied] = useState(false);
  const createPinRefs = useRef([]);
  const joinPinRefs = useRef([]);

  // FIX: adminId legittimo del nest a cui siamo iscritti come ospiti — ci serve
  // per verificare che un'offerta WebRTC arrivi davvero da lui (difesa aggiuntiva,
  // in complemento al controllo già fatto dal server).
  const expectedAdminIdRef = useRef(null);

  // --- STATI E REF PER TRASFERIMENTO FILE ---
  const fileInputRef = useRef(null);
  const receiveBuffer = useRef([]);
  const incomingFileInfo = useRef(null);
  const receivedSize = useRef(0);
  const lastProgressRef = useRef(0);
  const chunkCountRef = useRef(0); // FIX: conta i chunk per il merge periodico
  const stallTimeoutRef = useRef(null); // FIX: watchdog anti-blocco
  const [transferProgress, setTransferProgress] = useState(null);

  // FEAT: accumula i file già ricevuti di un invio multiplo, raggruppati per
  // batchId, finché non arrivano tutti — a quel punto vengono mostrati come
  // un unico messaggio invece che uno per file.
  const pendingBatchesRef = useRef({});

  // --- STATI PER LAYOUT DESKTOP ---
  const [activeBox, setActiveBox] = useState(null); // Può essere 'create' o 'join'
  const [nestName, setNestName] = useState('');

  const [isAdmin, setIsAdmin] = useState(false);
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const [showAbout, setShowAbout] = useState(false);

  const [roomTitle, setRoomTitle] = useState('Pigeon Nest');

  // FIX: azzera completamente lo stato di un trasferimento (sia in corso che bloccato)
  const resetTransferState = () => {
    receiveBuffer.current = [];
    incomingFileInfo.current = null;
    receivedSize.current = 0;
    lastProgressRef.current = 0;
    chunkCountRef.current = 0;
    if (stallTimeoutRef.current) {
      clearTimeout(stallTimeoutRef.current);
      stallTimeoutRef.current = null;
    }
    setTransferProgress(null);
  };

  // FIX: ogni volta che c'è un progresso reale, riarmiamo il watchdog.
  // Se non arriva più nulla entro STALL_TIMEOUT_MS, annulliamo automaticamente
  // invece di lasciare l'utente bloccato a fissare la schermata nera per sempre.
  const armStallWatchdog = () => {
    if (stallTimeoutRef.current) clearTimeout(stallTimeoutRef.current);
    stallTimeoutRef.current = setTimeout(() => {
      console.warn('Trasferimento bloccato: nessun progresso rilevato, reset forzato.');

      // FEAT: se il file bloccato faceva parte di un invio multiplo e alcuni
      // file del gruppo erano già arrivati per intero, li mostriamo comunque
      // invece di perderli silenziosamente.
      const stuckBatchId = incomingFileInfo.current?.batchId;
      if (stuckBatchId && pendingBatchesRef.current[stuckBatchId]?.files.length > 0) {
        const batch = pendingBatchesRef.current[stuckBatchId];
        delete pendingBatchesRef.current[stuckBatchId];
        setMessages(prev => [...prev, { sender: batch.sender, batch: true, files: batch.files }]);
      }

      resetTransferState();
      alert('Il trasferimento sembra essersi bloccato ed è stato annullato. Riprova.');
    }, STALL_TIMEOUT_MS);
  };

  useEffect(() => {
    socket.on('nest_created_success', (data) => {
      setRoomPin(data.pin);
      setCurrentPage('nest_created');
      setConnectionStatus('In attesa di dispositivi...');
    });

    socket.on('join_success', (data) => {
      setRoomPin(data.pin);
      expectedAdminIdRef.current = data.adminId; // FIX: salviamo chi è l'admin legittimo
      setRoomTitle(data.roomTitle || 'Pigeon Nest'); // NUOVO: prendiamo il nome dal server
      setCurrentPage('nest_created');
      setConnectionStatus('Connesso alla stanza. Avvio WebRTC...');
    });

    socket.on('device_joined', async (data) => {
      setConnectionStatus(`Dispositivo ${data.name} trovato! Creazione tunnel P2P...`);
      initWebRTC(data.id, true);
    });

    socket.on('webrtc_offer', async (data) => {
      // FIX: accettiamo un'offerta solo se proviene dall'admin del nest in cui siamo entrati.
      if (expectedAdminIdRef.current && data.senderId !== expectedAdminIdRef.current) {
        console.warn('Offerta WebRTC ignorata: mittente non riconosciuto come admin del nest.');
        return;
      }
      try {
        initWebRTC(data.senderId, false);
        await pcRef.current.setRemoteDescription(data.sdp);
        const answer = await pcRef.current.createAnswer();
        await pcRef.current.setLocalDescription(answer);
        socket.emit('webrtc_answer', { targetId: data.senderId, sdp: answer });
      } catch (err) {
        console.error('Errore durante la gestione di webrtc_offer:', err);
        setConnectionStatus('🔴 Errore di connessione, riprova.');
      }
    });

    socket.on('webrtc_answer', async (data) => {
      try {
        await pcRef.current.setRemoteDescription(data.sdp);
      } catch (err) {
        console.error('Errore durante la gestione di webrtc_answer:', err);
        setConnectionStatus('🔴 Errore di connessione, riprova.');
      }
    });

    socket.on('webrtc_ice_candidate', async (data) => {
      try {
        if (pcRef.current) {
          await pcRef.current.addIceCandidate(data.candidate);
        }
      } catch (err) {
        console.error('Errore durante l\'aggiunta di un ICE candidate:', err);
      }
    });

    socket.on('nest_destroyed', (data) => {
      alert(data.message);
      leaveCurrentNestLocalOnly(); // FIX: il server ha già distrutto il nest, non serve riavvisarlo
    });

    socket.on('kicked_by_admin', () => {
      alert('Sei stato rimosso dal Nest.');
      leaveCurrentNestLocalOnly();
    });

    socket.on('error', (data) => {
      alert(data?.message || 'Si è verificato un errore.');
    });

    return () => {
      socket.off('nest_created_success');
      socket.off('join_success');
      socket.off('device_joined');
      socket.off('webrtc_offer');
      socket.off('webrtc_answer');
      socket.off('webrtc_ice_candidate');
      socket.off('nest_destroyed');
      socket.off('kicked_by_admin');
      socket.off('error');
    };
  }, []);

  const initWebRTC = (targetId, isInitiator) => {
    // FIX: chiudiamo eventuali connessioni precedenti prima di crearne una nuova,
    // per evitare InvalidStateError da connessioni "fantasma".
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (dcRef.current) {
      dcRef.current.close();
      dcRef.current = null;
    }

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    pcRef.current = pc;

    pc.oniceconnectionstatechange = () => {
      console.log('[WebRTC] ICE state:', pc.iceConnectionState);
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('webrtc_ice_candidate', { targetId, candidate: event.candidate });
      }
    };

    if (isInitiator) {
      const dc = pc.createDataChannel('pigeon-transfer');
      setupDataChannel(dc);

      pc.createOffer().then(offer => {
        pc.setLocalDescription(offer);
        socket.emit('webrtc_offer', { targetId, sdp: offer });
      });
    } else {
      pc.ondatachannel = (event) => {
        setupDataChannel(event.channel);
      };
    }
  };

  const setupDataChannel = (dc) => {
  dcRef.current = dc;
  dc.binaryType = 'arraybuffer'; // FIX VELOCITÀ: torniamo a ricevere ArrayBuffer diretti

  dc.onopen = () => setConnectionStatus('🟢 Tunnel P2P Diretto Aperto!');
  dc.onclose = () => setConnectionStatus('🔴 Disconnesso');

  dc.onmessage = (event) => {
    // FIX VELOCITÀ: i chunk arrivano come ArrayBuffer, non più come JSON+base64
    if (event.data instanceof ArrayBuffer) {
      if (!incomingFileInfo.current) return;

      receiveBuffer.current.push(new Blob([event.data]));
      receivedSize.current += event.data.byteLength;
      chunkCountRef.current += 1;

      if (chunkCountRef.current % BLOB_MERGE_EVERY_N_CHUNKS === 0) {
        receiveBuffer.current = [new Blob(receiveBuffer.current)];
      }

      const { batchId, batchIndex, batchTotal } = incomingFileInfo.current;
      const progress = Math.round((receivedSize.current / incomingFileInfo.current.size) * 100);

      if (Number.isFinite(progress) && (progress > lastProgressRef.current || receivedSize.current >= incomingFileInfo.current.size)) {
        lastProgressRef.current = progress;
        setTransferProgress(
          batchTotal ? `Ricezione ${batchIndex + 1}/${batchTotal}: ${progress}%` : `Ricezione: ${progress}%`
        );
        armStallWatchdog();
      }

      if (receivedSize.current >= incomingFileInfo.current.size) {
        const blob = new Blob(receiveBuffer.current);
        const url = URL.createObjectURL(blob);
        const fileName = incomingFileInfo.current.name;
        const fileSender = incomingFileInfo.current.sender;
        const fileSize = incomingFileInfo.current.size;

        resetTransferState();

        if (batchId && batchTotal) {
          const batch = pendingBatchesRef.current[batchId] || { files: [], total: batchTotal, sender: fileSender };
          batch.files.push({ name: fileName, url, size: fileSize });
          pendingBatchesRef.current[batchId] = batch;
          if (batch.files.length >= batch.total) {
            delete pendingBatchesRef.current[batchId];
            setMessages(prev => [...prev, { sender: batch.sender, batch: true, files: batch.files }]);
          }
          return;
        }

        setMessages(prev => [...prev, { sender: fileSender, text: `File ricevuto: ${fileName}`, fileUrl: url, fileName }]);
      }
      return;
    }

    // Testo: file-meta o messaggio di chat (invariato)
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (err) {
      console.error('Errore lettura dati:', err);
      return;
    }

    if (data.type === 'file-meta') {
      // ... (blocco invariato, lascialo come già lo hai)
      const size = Number(data.size);
      const name = typeof data.name === 'string' && data.name.trim()
        ? data.name.trim().slice(0, 255)
        : 'file_sconosciuto';

      if (!Number.isFinite(size) || size < 0 || size > MAX_FILE_SIZE) {
        console.warn('file-meta non valido, ignorato:', data);
        return;
      }

      // FEAT: campi opzionali di raggruppamento per l'invio di più file insieme.
      const batchId = typeof data.batchId === 'string' ? data.batchId : null;
      const batchIndex = Number.isInteger(data.batchIndex) ? data.batchIndex : null;
      const batchTotal = Number.isInteger(data.batchTotal) && data.batchTotal > 0 ? data.batchTotal : null;

      incomingFileInfo.current = { ...data, size, name, batchId, batchIndex, batchTotal };
      receiveBuffer.current = [];
      receivedSize.current = 0;
      lastProgressRef.current = 0;
      chunkCountRef.current = 0;
      setTransferProgress(
        batchTotal ? `Ricezione ${batchIndex + 1}/${batchTotal}: 0%` : 'Ricezione: 0%'
      );
      armStallWatchdog();
      return;
    }

    if (typeof data.text === 'string') {
      setMessages(prev => [...prev, { sender: data.sender, text: data.text }]);
    }
  };
};

  const sendMessageP2P = () => {
    if (dcRef.current && dcRef.current.readyState === 'open' && textInput) {
      const payload = JSON.stringify({
        sender: userName,
        text: textInput
      });

      dcRef.current.send(payload);
      setMessages(prev => [...prev, { sender: 'Io', text: textInput }]);
      setTextInput('');
    }
  };



  // Valori pompati per saturare le reti moderne
  const CHUNK_SIZE = 128 * 1024; // 128KB - Dimezza il carico sul processore
  const HIGH_WATER_MARK = 4 * 1024 * 1024; // 4MB - Riempiamo bene il tubo prima di fermarci
  const LOW_WATER_MARK = 1 * 1024 * 1024; // 1MB - Riprendiamo a pompare senza far svuotare il tubo

  const sendSingleFileAsync = (file, batchInfo) => {
    return new Promise(async (resolve, reject) => { // Aggiunto 'async'
      const dc = dcRef.current;

      const metaData = JSON.stringify({
        type: 'file-meta',
        sender: userName || 'Io',
        name: file.name,
        size: file.size,
        ...(batchInfo ? { batchId: batchInfo.batchId, batchIndex: batchInfo.batchIndex, batchTotal: batchInfo.batchTotal } : {})
      });
      dc.send(metaData);

      dc.bufferedAmountLowThreshold = LOW_WATER_MARK;

      let offset = 0;
      let lastReported = 0;

      armStallWatchdog();

      try {
        // Usiamo un ciclo "while" fluido invece di ricorsione e FileReader
        while (offset < file.size) {
          
          // BACKPRESSURE: Se il tubo è pieno, mettiamo in pausa istantaneamente
          if (dc.bufferedAmount > HIGH_WATER_MARK) {
            await new Promise(r => {
              dc.onbufferedamountlow = () => {
                dc.onbufferedamountlow = null;
                r(); // Il tubo si è liberato, sblocca l'await e riparti
              };
            });
          }

          // LETTURA FULMINEA (No FileReader)
          const slice = file.slice(offset, offset + CHUNK_SIZE);
          const buffer = await slice.arrayBuffer(); 

          // INVIO DIRETTO
          dc.send(buffer);
          offset += buffer.byteLength;

          // PROGRESSO (Senza rallentare l'invio)
          const progress = Math.round((offset / file.size) * 100);
          if (progress > lastReported) {
            lastReported = progress;
            setTransferProgress(
              batchInfo ? `Invio ${batchInfo.batchIndex + 1}/${batchInfo.batchTotal}: ${progress}%` : `Invio: ${progress}%`
            );
            armStallWatchdog();
          }
        }
        
        resolve(); // Fine del file!
        
      } catch (error) {
        console.error("Errore durante l'invio del file:", error);
        reject(error);
      }
    });
  };


  const handleFileUpload = async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = ''; // reset subito l'input, come prima

    if (files.length === 0 || !dcRef.current || dcRef.current.readyState !== 'open') return;

    for (const f of files) {
      if (f.size > MAX_FILE_SIZE) {
        alert(`"${f.name}" è troppo grande (max ${(MAX_FILE_SIZE / (1024 * 1024 * 1024)).toFixed(1)} GB).`);
        return;
      }
    }

    try {
      if (files.length === 1) {
        // Comportamento invariato per il file singolo.
        await sendSingleFileAsync(files[0], null);
        resetTransferState();
        setMessages(prev => [...prev, { sender: 'Io', text: `Sent with my pigeon: ${files[0].name}` }]);
      } else {
        // FEAT: più file selezionati insieme -> stesso batchId per tutti,
        // inviati in sequenza (uno alla volta, mai in parallelo sullo stesso
        // canale) e riassunti in UN SOLO messaggio lato mittente.
        const batchId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const names = [];
        for (let i = 0; i < files.length; i++) {
          await sendSingleFileAsync(files[i], { batchId, batchIndex: i, batchTotal: files.length });
          names.push(files[i].name);
        }
        resetTransferState();
        setMessages(prev => [...prev, { sender: 'Io', text: `Sent with my pigeons: ${names.join(', ')}` }]);
      }
    } catch (error) {
      console.error("Errore tunnel P2P:", error);
      resetTransferState();
      alert("Errore durante l'invio. Riprova.");
    }
  };

  // FEAT: scarica in sequenza tutti i file di un messaggio raggruppato.
  // Nota: un sito web non può "aprire una cartella" sul dispositivo — questo
  // è il massimo che il browser permette, ovvero avviare il download di
  // ciascun file uno dopo l'altro.
  const downloadAllFiles = (files) => {
    files.forEach((f, i) => {
      setTimeout(() => {
        const a = document.createElement('a');
        a.href = f.url;
        a.download = f.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }, i * 300); // piccolo scaglionamento per evitare che il browser blocchi download multipli simultanei
    });
  };

  // FEAT: crea un messaggio locale con la tabella completa (Nome/Download/Dimensione)
  // di tutti i file di un batch — usato dal pulsante "Get info" quando ci sono
  // più file di quanti se ne possano mostrare nella card compatta.
  const showFilesInfoTable = (sender, files) => {
    setMessages(prev => [...prev, { sender, filesTable: true, files }]);
  };

  const handleCreateNest = () => {
    let ttl = 10;
    if (toggle5Min) ttl = 5;
    if (toggle15Min) ttl = 15;
    
    const customPin = createPin.join('').replace(/\s/g, '');
    
    if (customPin.length > 0 && customPin.length < 6) {
      alert('Attenzione: Il PIN personalizzato deve essere di 6 caratteri!');
      return; 
    }

    const pinToSend = customPin.length === 6 ? customPin : null; 
    
    if (!userName) setUserName('Admin'); 
    setIsAdmin(true);
    
    // NUOVO: Salva il nome del Nest scelto, o usa il default
    const chosenTitle = nestName.trim() !== '' ? nestName.trim() : 'Pigeon Nest';
    setRoomTitle(chosenTitle);

    socket.emit('create_nest', { ttl: ttl, customPin: pinToSend, nestName: chosenTitle });
  };

  const handleJoinNest = () => {
    setIsAdmin(false);
    const pinString = joinPin.join('');
    if (pinString.length === 6) {
      const finalName = userName || 'Ospite';
      setUserName(finalName);

      socket.emit('join_nest', { pin: pinString, userName: finalName });
    }
  };

  const handlePinChange = (index, value, type) => {
    const isCreate = type === 'create';
    const setPin = isCreate ? setCreatePin : setJoinPin;
    const currentPin = isCreate ? createPin : joinPin;
    const refs = isCreate ? createPinRefs : joinPinRefs;

    const newPin = [...currentPin];
    newPin[index] = value.toUpperCase();
    setPin(newPin);

    if (value && index < 5) {
      refs.current[index + 1].focus();
    }
  };

  const handlePinKeyDown = (e, index, type) => {
    const isCreate = type === 'create';
    const currentPin = isCreate ? createPin : joinPin;
    const refs = isCreate ? createPinRefs : joinPinRefs;

    if (e.key === 'Backspace' && !currentPin[index] && index > 0) {
      refs.current[index - 1].focus();
    }
  };

// NUOVO: incolla l'intero PIN copiato distribuendolo nelle 6 caselle,
// invece di doverlo scrivere una cifra alla volta.
const handlePinPaste = (e, type) => {
  e.preventDefault();
  const pasted = e.clipboardData.getData('text').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (!pasted) return;

  const setPin = type === 'create' ? setCreatePin : setJoinPin;
  const refs = type === 'create' ? createPinRefs : joinPinRefs;

  const newPin = ['', '', '', '', '', ''];
  for (let i = 0; i < pasted.length; i++) newPin[i] = pasted[i];
  setPin(newPin);

  const nextIndex = Math.min(pasted.length, 5);
  refs.current[nextIndex]?.focus();
};

  const handleCopyPin = async () => {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(roomPin);
      } catch (err) {
        console.error("Errore clipboard:", err);
      }
    } else {
      const textArea = document.createElement("textarea");
      textArea.value = roomPin;
      textArea.style.position = "fixed";
      textArea.style.opacity = "0";
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();

      try {
        document.execCommand("copy");
      } catch (err) {
        console.error("Errore execCommand:", err);
      }

      document.body.removeChild(textArea);
    }

    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  // FIX: pulizia locale dello stato + chiusura tunnel P2P, SENZA avvisare il server
  const resetLocalState = () => {
    if (dcRef.current) { dcRef.current.close(); dcRef.current = null; }
    if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }
    expectedAdminIdRef.current = null;
    resetTransferState();

    setRoomPin('...');
    setMessages([]);
    setConnectionStatus('In attesa...');
    setCreatePin(['', '', '', '', '', '']);
    setJoinPin(['', '', '', '', '', '']);
    setCurrentPage('home');
  };

  const leaveCurrentNest = () => {
    socket.emit('leave_nest', { pin: roomPin });
    resetLocalState();
    setIsAdmin(false);
    setShowExitConfirm(false);
  };

  // Gestisce il click sul tasto indietro distinguendo Admin da Ospite
  const handleBackClick = () => {
    if (isAdmin) {
      setShowExitConfirm(true);
    } else {
      leaveCurrentNest();
    }
  };

  const leaveCurrentNestLocalOnly = () => {
    resetLocalState();
  };

  return (
    <div className="min-h-screen bg-black text-white font-sans relative overflow-hidden flex justify-center">
      <div className="w-full max-w-5xl relative flex flex-col h-[100dvh] overflow-y-auto mx-auto">
        <div className="absolute top-[180px] left-1/2 -translate-x-1/2 w-[300px] h-[300px] bg-[#2958C2] rounded-full blur-[100px] opacity-40 pointer-events-none"></div>


        {/* HOME (LAYOUT DESKTOP/TABLET) */}
        {currentPage === 'home' && (
          <div className="flex-1 px-4 md:px-8 py-8 flex flex-col relative z-10 w-full">
            <h1 className="text-3xl md:text-4xl font-bold text-center text-white mb-6 leading-tight z-20">
              Transfer your file,<br />text, photo and<br />more.
            </h1>

            <div className="bg-[#191818] border border-[#646464] rounded-xl p-5 mb-4 z-20 w-full flex items-center justify-between gap-4">
              <div className="flex-1">
                <h2 className="font-semibold mb-3">How it works:</h2>
                <ul className="list-disc pl-5 space-y-1.5 text-sm text-gray-300">
                  <li>Create a new nest with personalised settings in the box on the left;</li>
                  <li>Click on the blue button to create a link to send to other devices ("+");</li>
                  <li>Send your pigeons!</li>
                </ul>
              </div>
              {/* NUOVO: logo cliccabile, ancorato al bordo destro con margine visibile */}
              <button
                onClick={() => setShowAbout(true)}
                className="flex-shrink-0 mr-3 w-16 h-16 md:w-20 md:h-20 rounded-2xl overflow-hidden hover:scale-105 active:scale-95 transition"
              >
                <img src="/pigeon_logo.jpg" alt="Carrier Pigeon logo" className="w-full h-full object-cover" />
              </button>
            </div>

            {/* GRIGLIA A 2 COLONNE */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 z-20 w-full items-stretch">

              {/* BOX SINISTRO: CREATE NEST */}
              <div
                onClick={() => setActiveBox('create')}
                className={`border border-[#646464] rounded-xl p-5 flex flex-col h-full transition-colors duration-300 cursor-pointer ${activeBox === 'create' ? 'bg-[#041737]' : 'bg-[#191818]'}`}
              >
                <h2 className="font-semibold mb-3 text-lg">Create your own Nest:</h2>

                <p className="text-base text-gray-400 mb-2 flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-gray-500"></span> Create a pin:
                </p>
                <div className="flex gap-2 mb-3 justify-between">
                  {[0, 1, 2, 3, 4, 5].map((index) => (
                    <input
                      key={index} ref={(el) => createPinRefs.current[index] = el}
                      type="text" maxLength="1" value={createPin[index]}
                      onChange={(e) => handlePinChange(index, e.target.value, 'create')}
                      onKeyDown={(e) => handlePinKeyDown(e, index, 'create')}
                      onPaste={(e) => handlePinPaste(e, 'create')}
                      className="w-full aspect-[4/5] bg-transparent border border-[#646464] rounded-lg text-center text-xl focus:outline-none focus:border-blue-500 uppercase"
                    />
                  ))}
                </div>

                <div className="border-t border-[#646464] my-2 -mx-[20px]"></div>

                <div className="flex justify-between items-center py-2">
                  <p className="text-base text-gray-300 flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-gray-500"></span> Self-destruction in 5 min.
                  </p>
                  <CustomToggle isOn={toggle5Min} onToggle={() => { setToggle5Min(!toggle5Min); if(!toggle5Min) setToggle15Min(false); }} />
                </div>

                <div className="border-t border-[#646464] my-2 -mx-[20px]"></div>

                <div className="flex justify-between items-center py-2">
                  <p className="text-base text-gray-300 flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-gray-500"></span> Self-destruction in 15 min.
                  </p>
                  <CustomToggle isOn={toggle15Min} onToggle={() => { setToggle15Min(!toggle15Min); if(!toggle15Min) setToggle5Min(false); }} />
                </div>

                <div className="border-t border-[#646464] my-2 -mx-[20px]"></div>
                  <p className="text-base text-gray-400 mb-2 flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-gray-500"></span> Set a nest name:
                </p>
                <input
                  type="text"
                  value={nestName}
                  onChange={(e) => setNestName(e.target.value)}
                  className="w-full h-11 bg-transparent border border-[#646464] rounded-lg px-4 focus:outline-none focus:border-blue-500"
                />

                <div className="border-t border-[#646464] my-2 -mx-[20px]"></div>

                {/* BOTTONI INTEGRATI (Box Sinistro) */}
                <div className="mt-auto flex justify-center items-center gap-3 md:gap-4 pt-4 w-full">
                  
                  <button
                    onClick={handleCreateNest}
                    className="h-14 flex-1 rounded-full bg-[#1b2a4d] flex items-center justify-center hover:bg-[#22335e] transition"
                  >
                    <Plus size={24} />
                  </button>
                  
                </div>
              </div>

              {/* BOX DESTRO: JOIN NEST */}
              <div
                onClick={() => setActiveBox('join')}
                className={`border border-[#646464] rounded-xl p-5 flex flex-col h-full transition-colors duration-300 cursor-pointer ${activeBox === 'join' ? 'bg-[#041737]' : 'bg-[#191818]'}`}
              >
                <h2 className="font-semibold mb-3 text-lg">Join a foreign nest:</h2>

                <p className="text-base text-gray-400 mb-2 flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-gray-500"></span> Insert the pin:
                </p>
                <div className="flex gap-2 mb-3 justify-between">
                  {[0, 1, 2, 3, 4, 5].map((index) => (
                    <input
                      key={index} ref={(el) => joinPinRefs.current[index] = el}
                      type="text" maxLength="1" value={joinPin[index]}
                      onChange={(e) => handlePinChange(index, e.target.value, 'join')}
                      onKeyDown={(e) => handlePinKeyDown(e, index, 'join')}
                      onPaste={(e) => handlePinPaste(e, 'join')}
                      className="w-full aspect-[4/5] bg-transparent border border-[#646464] rounded-lg text-center text-xl focus:outline-none focus:border-blue-500 uppercase"
                    />
                  ))}
                </div>

                <div className="border-t border-[#646464] my-2 -mx-[20px]"></div>
                <div className="flex-1"></div>
                <div className="border-t border-[#646464] my-2 -mx-[20px]"></div>

                <p className="text-base text-gray-400 mb-2 flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-gray-500"></span> Set your name:
                </p>
                <input
                  type="text"
                  value={userName}
                  onChange={(e) => setUserName(e.target.value)}
                  placeholder="es. MacBook Pro"
                  className="w-full h-11 bg-transparent border border-[#646464] rounded-lg px-4 focus:outline-none focus:border-blue-500"
                />

                <div className="border-t border-[#646464] my-2 -mx-[20px]"></div>

                {/* BOTTONE INTEGRATO (Box Destro) */}
                <div className="mt-auto flex justify-center items-center pt-4 w-full">
                  <button
                    onClick={handleJoinNest}
                    className="h-14 flex-1 rounded-full bg-[#1b2a4d] flex items-center justify-center hover:bg-[#22335e] transition"
                  >
                    <ArrowRight size={24} />
                  </button>
                </div>
              </div>

            </div>
          </div>
        )}



        {/* NEST CREATED & WEBRTC TEST */}
        {currentPage === 'nest_created' && (
          <div className="flex-1 px-4 flex flex-col relative z-10">
            {/* INTESTAZIONE CON TASTO INDIETRO */}
            <div className="flex items-center justify-between mb-6 mt-4">
              <button 
                onClick={handleBackClick}
                className="w-10 h-10 rounded-xl bg-[#2a2a2a] border border-[#646464] flex items-center justify-center hover:bg-gray-700 active:scale-95 transition"
              >
                <ArrowLeft size={20} className="text-gray-300" />
              </button>
              <h1 className="text-2xl md:text-3xl font-bold text-center text-white flex-1 mr-10 truncate">
                {roomTitle}
              </h1>
            </div>

            {/* MODALE DI CONFERMA PER L'ADMIN */}
            {showExitConfirm && (
              <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                <div className="bg-[#191818] border border-[#646464] rounded-2xl p-6 max-w-sm w-full text-center shadow-2xl">
                  <p className="text-white text-sm md:text-base font-semibold mb-6 leading-relaxed">
                    Tornare alla home chiuderà definitivamente la connessione, sicuro di voler continuare?
                  </p>
                  <div className="flex gap-4 justify-center">
                    <button
                      onClick={() => setShowExitConfirm(false)}
                      className="w-24 py-2 rounded-xl bg-[#2a2a2a] border border-[#646464] text-gray-300 hover:bg-gray-700 active:scale-95 transition font-medium"
                    >
                      No
                    </button>
                    <button
                      onClick={() => {
                        setShowExitConfirm(false);
                        leaveCurrentNest();
                      }}
                      className="w-24 py-2 rounded-xl bg-[#7B1919] hover:bg-red-700 active:scale-95 transition text-white font-medium shadow-lg shadow-red-950/50"
                    >
                      Sì
                    </button>
                  </div>
                </div>
              </div>
            )}

            

            {/* BOX 1: LINK E TASTO COPIA CON SPUNTA */}
            <div className="bg-[#191818] border border-[#646464] rounded-2xl p-5 mb-4 relative z-20">
              <h2 className="text-sm font-semibold mb-3">Link / PIN della stanza:</h2>
              <div className="flex items-center justify-between border border-[#646464] rounded-xl p-3 bg-black">
                <span className="text-xs text-gray-400 truncate w-3/4">
                  https://carrier_pigeon/room/<br />
                  <span className="text-blue-400 font-bold text-lg">{roomPin}</span>
                </span>

                <button
                  onClick={handleCopyPin}
                  className="p-2 border border-[#646464] rounded-lg bg-[#2a2a2a] transition-colors relative z-30 active:scale-90"
                >
                  {isCopied ? <Check size={16} className="text-green-400" /> : <Copy size={16} />}
                </button>
              </div>
            </div>

            {/* BOX CHAT/DATI P2P */}
            <div className="bg-[#191818] border border-[#646464] rounded-2xl p-4 flex-1 flex flex-col min-h-[200px] mb-4 relative">

              {/* Schermata Nera di caricamento File (Visibile solo durante l'invio/ricezione) */}
              {transferProgress && (
                <div className="absolute top-0 left-0 w-full h-full bg-black/90 z-40 rounded-2xl flex flex-col items-center justify-center gap-4">
                  <p className="text-blue-400 font-bold animate-pulse text-lg">{transferProgress}</p>
                  <button
                    onClick={() => {
                      resetTransferState();
                    }}
                    className="text-xs text-gray-400 underline hover:text-white transition"
                  >
                    Annulla trasferimento
                  </button>
                </div>
              )}

              <div className="flex-1 overflow-y-auto mb-4 space-y-2">
                {messages.length === 0 && <p className="text-xs text-gray-500 text-center mt-10">No pigeons have arrived yet...</p>}
                {messages.map((msg, idx) => (
                  <div
                    key={idx}
                    className={`p-2 rounded-lg text-sm ${(msg.batch || msg.filesTable) ? 'w-fit max-w-[95%]' : 'max-w-[80%]'} ${msg.sender === 'Io' ? 'bg-[#2958C2] ml-auto' : 'bg-[#2a2a2a] mr-auto'}`}
                  >
                    <span className="text-xs opacity-50 block mb-1">{msg.sender}</span>

                    {msg.batch ? (
                      // FEAT: messaggio con più file inviati insieme — fino a 3 file
                      // con blocco dedicato (nome + download). Il numero di colonne
                      // della griglia è dinamico (tanti quanti sono davvero gli
                      // elementi mostrati) invece che fisso a 4, altrimenti il box
                      // resta troppo largo/lungo quando i file sono solo 2 o 3.
                      // Il 4° slot (quando presente) è sempre un'azione aggregata:
                      // "Salva tutti" se il totale è ≤3 file, oppure "+n" con
                      // "Get info" se ce ne sono altri oltre ai 3 mostrati.
                      <>
                        <p className="text-sm mb-2">Set di file ricevuti:</p>
                        <div
                          className="grid gap-2"
                          style={{ gridTemplateColumns: `repeat(${Math.min(msg.files.length, 3) + 1}, minmax(90px, 1fr))` }}
                        >
                          {msg.files.slice(0, 3).map((f, i) => (
                            <div key={i} className="flex flex-col gap-1.5">
                              <p className="text-xs font-semibold truncate" title={f.name}>{f.name}</p>
                              <a
                                href={f.url}
                                download={f.name}
                                className="flex items-center justify-center gap-1.5 bg-black/40 p-2 rounded border border-white/20 hover:bg-black transition text-xs font-semibold"
                              >
                                <Download size={14} /> Scarica File
                              </a>
                            </div>
                          ))}
                          {msg.files.length > 3 ? (
                            <div className="flex flex-col gap-1.5">
                              <p className="text-xs font-semibold">+{msg.files.length - 3}</p>
                              <button
                                onClick={() => showFilesInfoTable(msg.sender, msg.files)}
                                className="flex items-center justify-center gap-1.5 bg-black/40 p-2 rounded border border-white/20 hover:bg-black transition text-xs font-semibold"
                              >
                                Get info
                              </button>
                            </div>
                          ) : (
                            <div className="flex flex-col gap-1.5 justify-end">
                              <button
                                onClick={() => downloadAllFiles(msg.files)}
                                className="flex items-center justify-center gap-1.5 bg-black/40 p-2 rounded border border-white/20 hover:bg-black transition text-xs font-semibold h-full"
                              >
                                Salva tutti
                              </button>
                            </div>
                          )}
                        </div>
                      </>
                    ) : msg.filesTable ? (
                      // FEAT: tabella completa dei file di un batch, generata localmente
                      // dal pulsante "Get info" — non viene inviata sul canale P2P,
                      // è solo un modo diverso di visualizzare file già ricevuti.
                      <div className="overflow-x-auto">
                        <table className="text-xs border-collapse">
                          <thead>
                            <tr className="text-gray-400 text-left">
                              <th className="pb-2 pr-6 font-normal">Name</th>
                              <th className="pb-2 pr-6 font-normal">Download</th>
                              <th className="pb-2 font-normal">Size</th>
                            </tr>
                          </thead>
                          <tbody>
                            {msg.files.map((f, i) => (
                              <tr key={i} className="border-t border-white/10">
                                <td className="py-2 pr-6 max-w-[220px] truncate" title={f.name}>{f.name}</td>
                                <td className="py-2 pr-6">
                                  <a
                                    href={f.url}
                                    download={f.name}
                                    className="inline-flex items-center justify-center w-8 h-8 rounded bg-black/40 border border-white/20 hover:bg-black transition"
                                  >
                                    <Download size={14} />
                                  </a>
                                </td>
                                <td className="py-2 text-gray-300 whitespace-nowrap">{formatFileSize(f.size)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <>
                        {msg.text}

                        {msg.fileUrl && (
                          <a
                            href={msg.fileUrl}
                            download={msg.fileName}
                            className="mt-3 flex items-center justify-center gap-2 bg-black/40 p-2 rounded border border-white/20 hover:bg-black transition text-xs font-semibold"
                          >
                            <Download size={16} /> Scarica File
                          </a>
                        )}
                      </>
                    )}
                  </div>
                ))}
              </div>

              <div className="flex gap-2">
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileUpload}
                  multiple
                  className="hidden"
                />

                <button
                  onClick={() => fileInputRef.current.click()}
                  disabled={!connectionStatus.includes('🟢')}
                  className="w-10 h-10 bg-[#2a2a2a] border border-[#646464] rounded-lg flex items-center justify-center disabled:opacity-50 hover:bg-gray-700 transition"
                >
                  <Paperclip size={16} className="text-gray-300" />
                </button>

                <input
                  type="text"
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') sendMessageP2P();
                  }}
                  placeholder="Invia testo o file..."
                  className="flex-1 h-10 bg-black border border-[#646464] rounded-lg px-3 text-sm focus:outline-none"
                  disabled={!connectionStatus.includes('🟢')}
                />

                <button
                  onClick={sendMessageP2P}
                  disabled={!connectionStatus.includes('🟢')}
                  className="w-10 h-10 bg-[#2958C2] rounded-lg flex items-center justify-center disabled:opacity-50 hover:bg-blue-600 transition"
                >
                  <Send size={16} />
                </button>
              </div>
            </div>
          </div>
        )}


      </div>

      {showAbout && (
        <div
          className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={() => setShowAbout(false)}
        >
          <div
            className="bg-[#0d0d0d] border border-[#333] rounded-2xl p-8 max-w-sm w-full text-center shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <img src="/pigeon_logo.jpg" alt="Carrier Pigeon logo" className="w-24 h-24 mx-auto mb-6 rounded-2xl" />
            <p className="text-white text-lg mb-6">
              This is <span className="italic">Carrier Pigeon (v.1)</span>
            </p>
            <p className="text-gray-300 mb-1">Developed by</p>
            <p className="text-white font-bold mb-6">JackSparr0w999</p>
            <p className="text-gray-300 text-sm leading-relaxed">
              Available on GitHub for free,<br />
              soon everywhere at a very<br />
              cheap price of 99999,99 $.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// FIX: l'export default avvolge il contenuto nell'Error Boundary
export default function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}
