
import 'dotenv/config';
import http from 'http';
import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenerativeAI } from '@google/generative-ai';

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));

const API_KEY = process.env.GEMINI_API_KEY || '';
const MODEL_NAME = process.env.MODEL_TEXT || 'gemini-1.5-flash';
const MODEL_LIVE = process.env.MODEL_LIVE || 'gemini-2.0-flash-exp';

if (!API_KEY) {
  console.warn('AVISO: GEMINI_API_KEY não configurada nas variáveis de ambiente.');
}

const genAI = new GoogleGenerativeAI(API_KEY);

app.get('/health', (_req, res) => {
  res.json({ ok: true, model: MODEL_NAME, provider: 'Google AI Studio (Gratuito)' });
});

app.post('/api/generate', async (req, res) => {
  try {
    const { contents, systemInstruction, config } = req.body || {};

    if (!contents || !Array.isArray(contents)) {
      return res.status(400).json({ 
        error: 'INVALID_REQUEST', 
        message: 'Campo "contents" é obrigatório e deve ser um array.' 
      });
    }

    const generativeModel = genAI.getGenerativeModel({
      model: MODEL_NAME,
      generationConfig: {
        maxOutputTokens: config?.maxOutputTokens || 3000,
        temperature: config?.temperature,
        topP: config?.topP,
        topK: config?.topK,
        responseMimeType: config?.responseMimeType,
        responseSchema: config?.responseSchema,
      },
      systemInstruction: systemInstruction ? systemInstruction : undefined,
    });

    const result = await generativeModel.generateContent({ contents });

    const response = result.response;
    const text = response.text ? response.text() : '';
    const candidate = response?.candidates?.[0];
    const finishReason = candidate?.finishReason;

    res.json({
      text,
      candidates: response?.candidates || [],
      finishReason,
    });
  } catch (error) {
    console.error('Erro ao chamar Gemini API:', error?.message || error);

    const status = error?.code || error?.status || 500;
    res.status(typeof status === 'number' ? status : 500).json({
      error: 'GEMINI_API_ERROR',
      message: error?.message || 'Erro desconhecido ao chamar o Gemini.',
    });
  }
});

const server = http.createServer(app);

// Relay de voz para Google AI Studio via WebSocket
const wss = new WebSocketServer({ server, path: '/live' });

wss.on('connection', async (clientWs) => {
  let upstreamWs = null;
  const queuedFromClient = [];

  try {
    const upstreamUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${API_KEY}`;
    upstreamWs = new WebSocket(upstreamUrl);

    upstreamWs.on('open', () => {
      queuedFromClient.forEach((msg) => upstreamWs.send(msg));
      queuedFromClient.length = 0;
    });

    upstreamWs.on('message', (data) => {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data.toString());
    });

    upstreamWs.on('close', (_code, reason) => {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1000, reason?.toString() || 'upstream_closed');
    });

    upstreamWs.on('error', (err) => {
      console.error('Erro no upstream do Gemini Live:', err?.message || err);
      if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1011, 'upstream_error');
    });
  } catch (err) {
    console.error('Falha ao conectar no Gemini Live:', err?.message || err);
    clientWs.close(1011, 'connection_failed');
    return;
  }

  clientWs.on('message', (data) => {
    const raw = data.toString();
    if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN) {
      upstreamWs.send(raw);
    } else {
      queuedFromClient.push(raw);
    }
  });

  clientWs.on('close', () => {
    if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN) upstreamWs.close();
  });
});

app.get('/live-config', (_req, res) => {
  res.json({
    model: `models/${MODEL_LIVE}`,
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Servidor VOIDY rodando na porta ${PORT}`);
  console.log(`Modelo texto: ${MODEL_NAME} | Modelo voz: ${MODEL_LIVE}`);
});
