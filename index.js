import 'dotenv/config';
import http from 'http';
import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));

const API_KEY = process.env.GEMINI_API_KEY || '';
const MODEL_NAME = process.env.MODEL_TEXT || 'gemini-1.5-flash';
const MODEL_LIVE = process.env.MODEL_LIVE || 'gemini-2.0-flash-exp';

if (!API_KEY) {
  console.warn('AVISO: GEMINI_API_KEY não configurada nas variáveis de ambiente.');
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, model: MODEL_NAME, provider: 'Google AI Studio (Direct HTTP)' });
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

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${API_KEY}`;
    
    const bodyData = {
      contents,
      generationConfig: {
        maxOutputTokens: config?.maxOutputTokens || 3000,
        temperature: config?.temperature,
        topP: config?.topP,
        topK: config?.topK,
        responseMimeType: config?.responseMimeType,
        responseSchema: config?.responseSchema,
      }
    };

    if (systemInstruction) {
      bodyData.systemInstruction = typeof systemInstruction === 'string' 
        ? { parts: [{ text: systemInstruction }] } 
        : systemInstruction;
    }

    const apiResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyData)
    });

    const data = await apiResponse.json();

    if (!apiResponse.ok) {
      return res.status(apiResponse.status).json(data);
    }

    const candidate = data?.candidates?.[0];
    const text = candidate?.content?.parts?.map(p => p.text || '').join('') || '';

    res.json({
      text,
      candidates: data?.candidates || [],
      finishReason: candidate?.finishReason,
    });
  } catch (error) {
    console.error('Erro ao chamar Gemini API:', error?.message || error);
    res.status(500).json({
      error: 'GEMINI_API_ERROR',
      message: error?.message || 'Erro interno ao chamar o Gemini.',
    });
  }
});

const server = http.createServer(app);

// Relay de voz via WebSocket
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

    upstreamWs.on('error', () => {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1011, 'upstream_error');
    });
  } catch (err) {
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
  res.json({ model: `models/${MODEL_LIVE}` });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Servidor VOIDY rodando na porta ${PORT}`);
});
