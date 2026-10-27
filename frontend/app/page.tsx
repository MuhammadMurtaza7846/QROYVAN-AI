'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { ArrowDown, ArrowRight, AudioLines, Captions, BookOpen, BrainCircuit, Check, ChevronDown, CircleHelp, CloudUpload, FileText, Globe, Home, LayoutGrid, LoaderCircle, MessageCircle, Mic, MicOff, Paperclip, Plus, Search, Send, Settings, ShieldCheck, Sparkles, Square, Trash2, Upload, Volume2, X, Zap } from 'lucide-react';

type Source = { filename: string; chunk: number; snippet: string };
type ChatMessage = { role: 'user' | 'assistant'; content: string; sources?: Source[]; pending?: boolean };
type Doc = { id: number; filename: string; chunks: number; created_at?: string };
const API = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8011';
const starter: ChatMessage[] = [{ role: 'assistant', content: 'Welcome to QROYVAN. Upload a document and ask me about it, or start a live voice conversation. I’ll cite the knowledge sources I use.' }];

export default function HomePage() {
  const [page, setPage] = useState('Home');
  const [messages, setMessages] = useState<ChatMessage[]>(starter);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState('');
  const [voiceState, setVoiceState] = useState<'idle'|'connecting'|'listening'|'speaking'|'error'>('idle');
  const voiceStateRef = useRef<'idle'|'connecting'|'listening'|'speaking'|'error'>('idle');
  const voiceAttemptRef = useRef(0);
  const voiceStartingRef = useRef(false);
  const [voiceTranscript, setVoiceTranscript] = useState('');
  const [isDictating, setIsDictating] = useState(false);
  const [search, setSearch] = useState('');
  const [showSources, setShowSources] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const chatSessionRef = useRef(0);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const liveSocketRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const micProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const playbackTimeRef = useRef(0);
  const playbackNodesRef = useRef<AudioBufferSourceNode[]>([]);
  const recognitionRef = useRef<any>(null);

  function updateVoiceState(next: 'idle'|'connecting'|'listening'|'speaking'|'error') {
    voiceStateRef.current = next;
    setVoiceState(next);
  }

  function toggleVoice() {
    const current = voiceStateRef.current;
    if (current === 'idle' || current === 'error') void startVoice();
    else void stopVoice();
  }

  const loadDocs = useCallback(async () => {
    try { const r = await fetch(`${API}/api/documents`); if (r.ok) setDocs(await r.json()); }
    catch { /* API may not be running during first render */ }
  }, []);
  useEffect(() => { void loadDocs(); }, [loadDocs]);
  useEffect(() => {
    const container = messagesRef.current;
    if (container) container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
  }, [messages]);
  useEffect(() => () => { void stopVoice(false); stopDictation(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function sendMessage(e?: FormEvent) {
    e?.preventDefault(); const text = input.trim(); if (!text || busy) return;
    const session = chatSessionRef.current;
    setInput(''); setPage('Chat'); setBusy(true);
    setMessages(prev => [...prev, { role: 'user', content: text }, { role: 'assistant', content: '', pending: true }]);
    try {
      const response = await fetch(`${API}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'The assistant could not answer.');
      if (session !== chatSessionRef.current) return;
      setMessages(prev => { const next = [...prev]; next[next.length - 1] = { role: 'assistant', content: data.answer, sources: data.sources || [] }; return next; });
    } catch (err) {
      if (session !== chatSessionRef.current) return;
      const message = err instanceof Error ? err.message : 'Could not reach the QROYVAN API.';
      setMessages(prev => { const next = [...prev]; next[next.length - 1] = { role: 'assistant', content: `I couldn’t complete that request: ${message}. Check that the backend is running and GEMINI_API_KEY is configured.` }; return next; });
    } finally { if (session === chatSessionRef.current) setBusy(false); }
  }

  function startNewChat() {
    chatSessionRef.current += 1; // Ignore replies from the previous conversation.
    setMessages(starter);
    setInput('');
    setBusy(false);
    setShowSources(true);
    setNotice('');
    setPage('Chat');
    if (voiceState !== 'idle') void stopVoice(false);
  }

  async function uploadFile(file?: File) {
    if (!file) return;
    setUploading(true); setNotice(`Indexing ${file.name}…`);
    const form = new FormData(); form.append('file', file);
    try {
      const r = await fetch(`${API}/api/documents`, { method: 'POST', body: form }); const data = await r.json();
      if (!r.ok) throw new Error(data.detail || 'Upload failed');
      setNotice(`${data.filename} is ready for questions.`); await loadDocs(); setPage('Chat');
    } catch (err) { setNotice(err instanceof Error ? err.message : 'Upload failed.'); }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; }
  }

  async function removeDoc(id: number) {
    try { const r = await fetch(`${API}/api/documents/${id}`, { method: 'DELETE' }); if (!r.ok) throw new Error('Could not delete document'); await loadDocs(); setNotice('Document deleted.'); }
    catch (err) { setNotice(err instanceof Error ? err.message : 'Delete failed'); }
  }

  // Browser-native speech recognition provides speech-to-text without requiring another API key.
  // It is intentionally separate from the existing realtime voice session so current voice behavior stays intact.
  function startDictation() {
    if (isDictating) { stopDictation(); return; }
    if (typeof window === 'undefined') return;
    const SpeechRecognitionCtor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      setNotice('Speech-to-text is not supported by this browser. Please use the latest Chrome or Edge.');
      return;
    }
    try {
      const recognition = new SpeechRecognitionCtor();
      recognitionRef.current = recognition;
      recognition.lang = navigator.language || 'en-US';
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      let finalText = '';
      setVoiceTranscript('');
      setIsDictating(true);
      setNotice('Speech-to-text is listening. Speak, then press the captions button to finish.');
      recognition.onresult = (event: any) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcript = event.results[i]?.[0]?.transcript || '';
          if (event.results[i].isFinal) finalText += `${transcript} `;
          else interim += transcript;
        }
        const combined = `${finalText}${interim}`.trim();
        setVoiceTranscript(combined);
      };
      recognition.onerror = (event: any) => {
        if (event.error !== 'no-speech' && event.error !== 'aborted') setNotice(`Speech-to-text issue: ${event.error || 'unknown error'}. Check microphone permission.`);
      };
      recognition.onend = () => {
        const text = finalText.trim();
        setIsDictating(false);
        recognitionRef.current = null;
        if (text) {
          setInput(text);
          setPage('Chat');
          setNotice('Transcript added to chat. Review it and press Send when ready.');
        }
      };
      recognition.start();
    } catch (err) {
      setIsDictating(false);
      recognitionRef.current = null;
      setNotice(err instanceof Error ? err.message : 'Could not start speech-to-text.');
    }
  }

  function stopDictation(showNotice = true) {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    setIsDictating(false);
    try { recognition?.stop(); } catch {}
    if (showNotice && !recognition) setNotice('Speech-to-text is not currently listening.');
  }

  function bytesToBase64(bytes: Uint8Array) {
    let binary = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step));
    return btoa(binary);
  }

  function floatToPcm16Base64(samples: Float32Array, sourceRate: number) {
    const targetRate = 16000;
    const ratio = sourceRate / targetRate;
    const outLength = Math.max(1, Math.floor(samples.length / ratio));
    const pcm = new Int16Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const sourceIndex = Math.min(samples.length - 1, Math.floor(i * ratio));
      const value = Math.max(-1, Math.min(1, samples[sourceIndex]));
      pcm[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
    }
    return bytesToBase64(new Uint8Array(pcm.buffer));
  }

  function playGeminiAudio(base64: string) {
    const context = audioContextRef.current;
    if (!context) return;
    const binary = atob(base64);
    const pcm = new Int16Array(binary.length / 2);
    for (let i = 0; i < pcm.length; i++) pcm[i] = (binary.charCodeAt(i * 2) & 255) | (binary.charCodeAt(i * 2 + 1) << 8);
    const audioBuffer = context.createBuffer(1, pcm.length, 24000);
    const channel = audioBuffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;
    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime + 0.02, playbackTimeRef.current);
    source.onended = () => { playbackNodesRef.current = playbackNodesRef.current.filter(node => node !== source); };
    playbackNodesRef.current.push(source);
    source.start(startAt);
    playbackTimeRef.current = startAt + audioBuffer.duration;
  }

  async function startVoice() {
    if (voiceStartingRef.current || ['connecting', 'listening', 'speaking'].includes(voiceStateRef.current)) return;
    voiceStartingRef.current = true;
    const attempt = ++voiceAttemptRef.current;
    const isCurrentAttempt = () => voiceAttemptRef.current === attempt;
    updateVoiceState('connecting');
    setNotice('');
    setVoiceTranscript('');
    try {
      const tokenRes = await fetch(`${API}/api/voice/session`, { method: 'POST' });
      const tokenData = await tokenRes.json();
      if (!tokenRes.ok) throw new Error(tokenData.detail || `Could not create Gemini Live session (${tokenRes.status})`);
      if (!isCurrentAttempt()) return;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (!isCurrentAttempt()) { stream.getTracks().forEach(track => track.stop()); return; }
      streamRef.current = stream;
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      await audioContext.resume();
      const socketUrl = `${tokenData.websocket_url}?access_token=${encodeURIComponent(tokenData.token)}`;
      const socket = new WebSocket(socketUrl);
      liveSocketRef.current = socket;

      socket.onopen = () => {
        if (!isCurrentAttempt()) return;
        socket.send(JSON.stringify({ setup: {
          model: `models/${tokenData.model}`,
          generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: tokenData.voice || 'Puck' } } } },
          systemInstruction: { parts: [{ text: 'You are QROYVAN, a warm, concise voice assistant. Speak naturally in the user’s language. Allow the user to interrupt you. If asked about uploaded documents, explain that they can use chat to search indexed files; never invent file contents.' }] },
          inputAudioTranscription: {}, outputAudioTranscription: {}, realtimeInputConfig: { automaticActivityDetection: {} }
        }}));
      };
      socket.onmessage = event => {
        if (!isCurrentAttempt()) return;
        try {
          const data = JSON.parse(typeof event.data === 'string' ? event.data : '');
          if (data.setupComplete) {
            updateVoiceState('listening');
            setNotice('Gemini voice connected. Speak naturally; interruptions are supported.');
          }
          if (data.serverContent?.interrupted) {
            playbackNodesRef.current.forEach(node => { try { node.stop(); } catch {} });
            playbackNodesRef.current = [];
            playbackTimeRef.current = audioContext.currentTime;
            updateVoiceState('listening');
          }
          const inputText = data.serverContent?.inputTranscription?.text;
          if (inputText) {
            setVoiceTranscript(prev => `${prev} ${inputText}`.trim());
            setMessages(prev => [...prev, { role: 'user', content: inputText }]);
            updateVoiceState('listening');
          }
          const outputText = data.serverContent?.outputTranscription?.text;
          if (outputText) setMessages(prev => [...prev, { role: 'assistant', content: outputText }]);
          const parts = data.serverContent?.modelTurn?.parts || [];
          for (const part of parts) {
            const audioData = part.inlineData?.data;
            if (audioData) { playGeminiAudio(audioData); updateVoiceState('speaking'); }
            if (part.text) setMessages(prev => [...prev, { role: 'assistant', content: part.text }]);
          }
          if (data.serverContent?.turnComplete) updateVoiceState('listening');
          if (data.toolCall) {
            // Tool calls are intentionally not claimed as implemented in this direct voice session.
            socket.send(JSON.stringify({ toolResponse: { functionResponses: data.toolCall.functionCalls.map((call: any) => ({ id: call.id, name: call.name, response: { error: 'Use the QROYVAN chat page for document-grounded answers.' } })) } }));
          }
        } catch { /* ignore malformed websocket frames */ }
      };
      socket.onerror = () => { if (isCurrentAttempt()) setNotice('Gemini voice connection error. Check your API key, model access, and internet.'); };
      socket.onclose = event => {
        if (isCurrentAttempt() && voiceStateRef.current !== 'idle') {
          updateVoiceState('error');
          setNotice(event.reason || 'Gemini voice session closed. Try reconnecting.');
        }
      };

      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      micProcessorRef.current = processor;
      processor.onaudioprocess = event => {
        const silentOutput = event.outputBuffer.getChannelData(0);
        silentOutput.fill(0);
        if (!isCurrentAttempt() || socket.readyState !== WebSocket.OPEN) return;
        const samples = event.inputBuffer.getChannelData(0);
        socket.send(JSON.stringify({ realtimeInput: { audio: { data: floatToPcm16Base64(samples, audioContext.sampleRate), mimeType: 'audio/pcm;rate=16000' } } }));
      };
      source.connect(processor);
      processor.connect(audioContext.destination);
    } catch (err) {
      if (!isCurrentAttempt()) return;
      await stopVoice(false);
      updateVoiceState('error');
      setNotice(err instanceof Error ? err.message : 'Could not start Gemini voice. Check microphone permission and GEMINI_API_KEY.');
    } finally {
      if (isCurrentAttempt()) voiceStartingRef.current = false;
    }
  }

  async function stopVoice(showNotice = true) {
    voiceAttemptRef.current += 1;
    voiceStartingRef.current = false;
    try { micProcessorRef.current?.disconnect(); } catch {}
    micProcessorRef.current = null;
    try { liveSocketRef.current?.close(); } catch {}
    liveSocketRef.current = null;
    streamRef.current?.getTracks().forEach(track => track.stop()); streamRef.current = null;
    if (audioContextRef.current) { void audioContextRef.current.close().catch(() => {}); audioContextRef.current = null; }
    playbackNodesRef.current.forEach(node => { try { node.stop(); } catch {} });
    playbackNodesRef.current = [];
    playbackTimeRef.current = 0;
    updateVoiceState('idle');
    if (showNotice) setNotice('Voice conversation ended.');
  }

  const nav = [ { label: 'Home', icon: Home }, { label: 'Chat', icon: MessageCircle }, { label: 'Tasks', icon: Check }, { label: 'Memory', icon: BrainCircuit }, { label: 'Apps & Tools', icon: LayoutGrid }, { label: 'Settings', icon: Settings } ];
  const filteredDocs = docs.filter(d => d.filename.toLowerCase().includes(search.toLowerCase()));
  const orbLabel = ({ idle: 'Ready when you are', connecting: 'Connecting to voice…', listening: 'Listening — go ahead', speaking: 'QROYVAN is speaking', error: 'Voice connection needs attention' } as const)[voiceState];

  return <main className="app-shell">
    <div className="backdrop" />
    <aside className="sidebar glass-panel">
      <button className="brand" onClick={() => setPage('Home')} aria-label="QROYVAN home"><span className="brand-orb"><span /></span><span className="brand-copy"><b>QROYVAN</b><small>AI ASSISTANT</small></span></button>
      <nav>{nav.map(({label, icon: Icon}) => <button key={label} className={`nav-item ${page === label ? 'active' : ''}`} onClick={() => setPage(label)}><Icon size={18}/><span>{label}</span>{label === 'Memory' && docs.length > 0 && <em>{docs.length}</em>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="quote">“The best way to predict the future is to create it.”<b>— QROYVAN</b></div><div className="user-pill"><div className="avatar">Q</div><div><small>Welcome back</small><strong>Guest User</strong></div><ChevronDown size={15}/></div></div>
    </aside>

    <section className="workspace">

      {page === 'Home' && <div className="home-view">
        <div className="hero-copy"><span className="eyebrow"><Sparkles size={14}/> YOUR PERSONAL KNOWLEDGE AI</span><h1>Your knowledge.<br/><span>In conversation.</span></h1><p>Ask your documents, explore ideas, get answers with sources.</p></div>
        <div className={`orb-stage ${voiceState}`}><div className="orb-grid"/><div className="orbit orbit-one"/><div className="orbit orbit-two"/><button className="orb-button" onClick={toggleVoice} aria-label={voiceState === 'idle' ? 'Start voice conversation' : 'End voice conversation'}><div className="orb-core"><div className="orb-shine"/><div className="orb-ribbon ribbon-a"/><div className="orb-ribbon ribbon-b"/><div className="orb-ribbon ribbon-c"/></div></button><div className="orb-pedestal"><span/></div><div className={`voice-transcript-control ${voiceState}`} aria-live="polite">
  <span className="voice-transcript-text">
    {voiceTranscript || (voiceState === 'idle' ? 'Click the mic to start speaking' : voiceState === 'error' ? 'Voice connection failed — try again' : orbLabel)}
  </span>
  <button
    type="button"
    className={`voice-transcript-mic ${voiceState === 'connecting' || voiceState === 'listening' || voiceState === 'speaking' ? 'active' : ''}`}
    onClick={toggleVoice}
    aria-label={voiceState === 'connecting' || voiceState === 'listening' || voiceState === 'speaking' ? 'Stop voice conversation' : 'Start voice conversation'}
    title={voiceState === 'connecting' || voiceState === 'listening' || voiceState === 'speaking' ? 'Stop voice conversation' : 'Start voice conversation'}
  >
    {voiceState === 'connecting' ? <LoaderCircle className="spin" size={20}/> : voiceState === 'idle' || voiceState === 'error' ? <MicOff size={20}/> : <Mic size={20}/>}
  </button>
</div><div className="orb-status"><span className={voiceState === 'error' ? 'status-red' : ''}/>{orbLabel}</div></div>
        <div className="home-voice-actions" aria-label="Voice assistant actions">
          <button type="button" className="home-chat-button" onClick={() => setPage('Chat')} title="Open chat" aria-label="Open chat">
            <MessageCircle size={18}/><span>Chat</span>
          </button>
          <button type="button" className="home-upload-button" onClick={() => { setPage('Chat'); fileRef.current?.click(); }} title="Open chat and attach a file" aria-label="Open chat and attach a file">
            <Paperclip size={17}/><span>Attach file</span>
          </button>
          <button type="button" className={`home-mic-button ${voiceState !== 'idle' && voiceState !== 'error' ? 'active' : ''}`} onClick={toggleVoice} title={voiceState === 'idle' || voiceState === 'error' ? 'Turn voice assistant on' : 'Turn voice assistant off'} aria-label={voiceState === 'idle' || voiceState === 'error' ? 'Turn voice assistant on' : 'Turn voice assistant off'}>
            {voiceState === 'connecting' ? <LoaderCircle className="spin" size={18}/> : voiceState === 'idle' || voiceState === 'error' ? <MicOff size={18}/> : <Mic size={18}/>}<span>{voiceState === 'idle' || voiceState === 'error' ? 'Voice off' : voiceState === 'connecting' ? 'Connecting' : 'Voice on'}</span>
          </button>
        </div>
        </div>}

      {page === 'Chat' && <section className="chat-view"><div className="section-heading"><div><span className="eyebrow">QROYVAN ASSISTANT</span><h2>Chat with QROYVAN</h2><p>Your thoughts, ideas and questions — grounded in your knowledge.</p></div><div className="chat-heading-actions"><button className="outline-button new-chat-button" onClick={startNewChat} title="Start a fresh conversation"><Plus size={16}/> New Chat</button></div></div>
        <div className="messages" ref={messagesRef}>{messages.map((m, i) => <div className={`message-row ${m.role}`} key={`${i}-${m.role}`}><div className={`message-avatar ${m.role}`}>{m.role === 'assistant' ? <span className="mini-orb"/> : 'Y'}</div><div className="message-body"><div className="message-name">{m.role === 'assistant' ? 'QROYVAN' : 'You'} <small>{m.pending ? 'Thinking…' : ''}</small></div><div className={`message-bubble ${m.pending ? 'pending' : ''}`}>{m.pending ? <span className="typing"><i/><i/><i/></span> : m.content}</div>{m.sources && m.sources.length > 0 && <div className="source-list"><button className="source-toggle" onClick={() => setShowSources(!showSources)}><ShieldCheck size={14}/> {m.sources.length} knowledge sources <ChevronDown size={13} className={showSources ? '' : 'rotated'}/></button>{showSources && <div className="source-chips">{m.sources.map((s, n) => <details key={`${s.filename}-${n}`} className="source-chip"><summary><FileText size={13}/>{s.filename} Â· chunk {s.chunk}</summary><p>{s.snippet}</p></details>)}</div>}</div>}</div></div>)}</div>
        {voiceState !== 'idle' && <div className={`voice-banner ${voiceState}`}><div className="waveform">{Array.from({length: 21}, (_,i) => <i key={i} style={{'--bar': `${10 + ((i*7)%22)}px`} as CSSProperties}/>)}</div><div><b>{orbLabel}</b><small>{voiceTranscript ? `Last heard: “${voiceTranscript}”` : 'Speak naturally. You can interrupt at any time.'}</small></div><button onClick={toggleVoice}><Square size={14}/> End</button></div>}
        <form className="chat-composer" onSubmit={sendMessage}><button type="button" title="Attach file" onClick={() => fileRef.current?.click()}><Paperclip size={18}/></button><button type="button" className={`dictation-chat-button ${isDictating ? 'active' : ''}`} onClick={() => isDictating ? stopDictation() : startDictation()} title={isDictating ? 'Finish speech-to-text' : 'Speech-to-text'} aria-label={isDictating ? 'Finish speech-to-text' : 'Speech-to-text'}>{isDictating ? <Square size={18}/> : <Captions size={18}/>}</button><input value={input} onChange={e => setInput(e.target.value)} placeholder="Type your message..."/><button className="send-button" type="submit" disabled={!input.trim() || busy}><Send size={18}/></button></form>
      </section>}

      {page === 'Memory' && <section className="content-view"><div className="section-heading"><div><span className="eyebrow">YOUR PERSONAL KNOWLEDGE HUB</span><h2>Knowledge & Memory</h2><p>Upload documents and ask QROYVAN questions about their contents.</p></div><button className="primary-button" onClick={() => fileRef.current?.click()}><Plus size={17}/> Add knowledge</button></div><div className="memory-stats"><div><FileText/><b>{docs.length}</b><span>Documents</span></div><div><BrainCircuit/><b>{docs.reduce((n,d) => n+d.chunks,0)}</b><span>Indexed chunks</span></div><div><ShieldCheck/><b>RAG</b><span>Retrieval enabled</span></div></div><div className="upload-drop" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); void uploadFile(e.dataTransfer.files[0]); }}><div className="upload-icon"><Upload size={23}/></div><b>{uploading ? 'Indexing your document…' : 'Bring your knowledge to QROYVAN'}</b><p>Drag and drop PDF, DOCX, TXT, MD, CSV or JSON files here</p><button className="outline-button" onClick={() => fileRef.current?.click()} disabled={uploading}>{uploading ? <LoaderCircle className="spin" size={16}/> : <Plus size={16}/>} Choose file</button><small>Maximum file size: 20 MB. Text is extracted and indexed for semantic search.</small></div><div className="list-heading"><h3>Your knowledge sources</h3><span>{filteredDocs.length} items</span></div><div className="document-list">{filteredDocs.length ? filteredDocs.map(d => <div className="document-row" key={d.id}><span className="doc-icon"><FileText size={20}/></span><div className="doc-meta"><b>{d.filename}</b><small>{d.chunks} indexed chunks Â· {d.created_at ? new Date(d.created_at).toLocaleDateString() : 'Recently added'}</small></div><span className="indexed"><span/> Indexed</span><button className="icon-button delete-button" title={`Delete ${d.filename}`} onClick={() => void removeDoc(d.id)}><Trash2 size={16}/></button></div>) : <div className="empty-state"><BookOpen size={28}/><b>No knowledge sources yet</b><p>Upload a document to start asking questions with citations.</p></div>}</div></section>}

      {page === 'Tasks' && <section className="content-view"><div className="section-heading"><div><span className="eyebrow">YOUR WORKSPACE</span><h2>Tasks & Actions</h2><p>Keep your AI workflow organized.</p></div><button className="primary-button" onClick={() => setNotice('Task creation is a planned extension. Chat, RAG, uploads and voice are available in this starter.')}><Plus size={17}/> New task</button></div><div className="feature-grid"><div className="feature-card"><Zap/><h3>Ask your documents</h3><p>Retrieve facts and answers from indexed files.</p><button onClick={() => setPage('Memory')}>Open knowledge <ArrowRight size={14}/></button></div><div className="feature-card"><MessageCircle/><h3>Start a conversation</h3><p>Ask questions with cited source passages.</p><button onClick={() => setPage('Chat')}>Open chat <ArrowRight size={14}/></button></div><div className="feature-card"><Mic/><h3>Voice assistant</h3><p>Talk naturally and interrupt the assistant.</p><button onClick={toggleVoice}>Start speaking <ArrowRight size={14}/></button></div></div></section>}

      {page === 'Apps & Tools' && <section className="content-view"><div className="section-heading"><div><span className="eyebrow">YOUR AI TOOLKIT</span><h2>Apps & Tools</h2><p>Useful capabilities, unified in one workspace.</p></div></div><div className="tool-grid">{[{icon:Search,name:'Knowledge Search',desc:'Find relevant passages across your files',action:()=>setPage('Memory')},{icon:MessageCircle,name:'AI Chat',desc:'Ask grounded questions and follow up',action:()=>setPage('Chat')},{icon:AudioLines,name:'Live Voice',desc:'Real-time speech-to-speech assistant',action:()=>void startVoice()},{icon:CloudUpload,name:'Document Ingestion',desc:'Upload and index your knowledge base',action:()=>fileRef.current?.click()},{icon:Globe,name:'Web Search',desc:'External web search can be added as a tool',action:()=>setNotice('Web search is not enabled in this starter; connect an approved search provider to add it.')},{icon:Settings,name:'Preferences',desc:'Review configuration and status',action:()=>setPage('Settings')}].map(({icon:Icon,name,desc,action})=><button className="tool-card" key={name} onClick={action}><span><Icon size={22}/></span><b>{name}</b><p>{desc}</p><ArrowRight size={16}/></button>)}</div></section>}

      {page === 'Settings' && <section className="content-view"><div className="section-heading"><div><span className="eyebrow">PREFERENCES</span><h2>Settings</h2><p>Manage your QROYVAN setup.</p></div></div><div className="settings-card"><div className="settings-title"><span className="avatar large">Q</span><div><b>Guest workspace</b><p>Local development environment</p></div><span className="pill">Starter</span></div><div className="settings-row"><div><b>Backend API</b><small>{API}</small></div><span className="indexed"><span/> Configured URL</span></div><div className="settings-row"><div><b>Knowledge retrieval</b><small>Embeddings + PostgreSQL pgvector</small></div><span className="pill">RAG</span></div><div className="settings-row"><div><b>Voice connection</b><small>WebRTC Realtime API Â· browser microphone</small></div><span className="pill">{voiceState === 'idle' ? 'Disconnected' : voiceState}</span></div><div className="settings-note"><ShieldCheck size={18}/><p>Keep API keys on the backend. Before deploying publicly, add authentication, per-user data isolation, rate limits and HTTPS.</p></div></div></section>}

      <footer className="footer"><span>QROYVAN <i>AI</i></span><span><span className="online-dot"/> Knowledge in conversation</span><span>Built for your ideas <Sparkles size={12}/></span></footer>
    </section>

    <input ref={fileRef} type="file" accept=".pdf,.docx,.txt,.md,.csv,.json" hidden onChange={e => void uploadFile(e.target.files?.[0])}/>
    {notice && <div className="toast"><span>{notice}</span><button onClick={() => setNotice('')} aria-label="Dismiss"><X size={15}/></button></div>}
  </main>;
}




