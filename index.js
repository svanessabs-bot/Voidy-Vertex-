import 'dotenv/config';
import http from 'http';
import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI } from '@google/genai';

const app = express();
app.use(cors()); // Em produção, restrinja para o domínio do seu app: cors({ origin: 'https://seuapp.vercel.app' })
app.use(express.json({ limit: '25mb' })); // Mensagens com imagem em base64 podem ser grandes

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL_TEXT = process.env.MODEL_TEXT || 'gemini-3.7-flash';
const MODEL_LIVE = process.env.MODEL_LIVE || 'gemini-3.1-flash-live-preview';

if (!API_KEY) {
  console.error('ERRO: defina GEMINI_API_KEY no .env (ou nas variáveis de ambiente do Render).');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: API_KEY });

app.get('/health', (_req, res) => {
  res.json({ ok: true, model: MODEL_TEXT });
});

/**
 * Espera receber do frontend exatamente o que o AIService já monta:
 * { contents, systemInstruction, config: { maxOutputTokens, ... } }
 */
app.post('/api/generate', async (req, res) => {
  try {
    const { contents, systemInstruction, config, model } = req.body || {};

    if (!contents || !Array.isArray(contents)) {
      return res.status(400).json({ error: 'INVALID_REQUEST', message: 'Campo "contents" é obrigatório e deve ser um array.' });
    }

    const result = await ai.models.generateContent({
      model: model || MODEL_TEXT,
      contents,
      config: {
        maxOutputTokens: config?.maxOutputTokens || 3000,
        temperature: config?.temperature,
        topP: config?.topP,
        topK: config?.topK,
        responseMimeType: config?.responseMimeType,
        responseSchema: config?.responseSchema,
        systemInstruction: systemInstruction || undefined,
      },
    });

    const text = (result.text || '').trim();

    res.json({
      text,
      candidates: result.candidates || [],
      finishReason: result.candidates?.[0]?.finishReason,
    });
  } catch (error) {
    console.error('Erro ao chamar a API Gemini:', error?.message || error);
    const status = error?.status || 500;
    res.status(typeof status === 'number' ? status : 500).json({
      error: 'GEMINI_API_ERROR',
      message: error?.message || 'Erro desconhecido ao chamar a API Gemini.',
    });
  }
});

const server = http.createServer(app);

// Relay de voz (Live API). O navegador conecta em ws://SEU_BACKEND/live
// e o backend adiciona a chave da API antes de repassar pro Google —
// a chave nunca aparece no navegador nem no APK.
const wss = new WebSocketServer({ server, path: '/live' });

wss.on('connection', (clientWs) => {
  const upstreamUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${API_KEY}`;
  const upstreamWs = new WebSocket(upstreamUrl);
  const queuedFromClient = []; // Mensagens que chegam do navegador antes do upstream abrir

  upstreamWs.on('open', () => {
    queuedFromClient.forEach((msg) => upstreamWs.send(msg));
    queuedFromClient.length = 0;
  });

  // Google -> backend -> navegador
  upstreamWs.on('message', (data) => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data.toString());
  });
  upstreamWs.on('close', (code, reason) => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1000, reason?.toString() || 'upstream_closed');
  });
  upstreamWs.on('error', (err) => {
    console.error('Erro no upstream da Live API:', err?.message || err);
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1011, 'upstream_error');
  });

  // Navegador -> backend -> Google
  clientWs.on('message', (data) => {
    const raw = data.toString();
    if (upstreamWs.readyState === WebSocket.OPEN) {
      upstreamWs.send(raw);
    } else {
      queuedFromClient.push(raw);
    }
  });

  clientWs.on('close', () => {
    if (upstreamWs.readyState === WebSocket.OPEN) upstreamWs.close();
  });
});

// Expõe pro frontend qual é o nome do modelo de voz a usar na mensagem de setup
app.get('/live-config', (_req, res) => {
  res.json({ model: `models/${MODEL_LIVE}` });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Servidor VOIDY (Gemini API) rodando na porta ${PORT}`);
  console.log(`Modelo texto: ${MODEL_TEXT} | Modelo voz: ${MODEL_LIVE}`);
  console.log(`Relay de voz disponível em ws://localhost:${PORT}/live`);
});
