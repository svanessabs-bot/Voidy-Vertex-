import 'dotenv/config';
import http from 'http';
import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleAuth } from 'google-auth-library';
import { VertexAI } from '@google-cloud/vertexai';

const app = express();
app.use(cors()); // Em produção, restrinja para o domínio do seu app: cors({ origin: 'https://seuapp.com' })
app.use(express.json({ limit: '25mb' })); // Mensagens com imagem em base64 podem ser grandes

const PROJECT_ID = process.env.GCP_PROJECT_ID;
const LOCATION = process.env.GCP_LOCATION || 'us-central1';
const MODEL_NAME = process.env.MODEL_TEXT || 'gemini-3.7-flash';
const MODEL_LIVE = process.env.MODEL_LIVE || 'gemini-3.1-flash-live-preview';

// Cliente de autenticação usado só pelo relay de voz (precisa de token OAuth Bearer,
// diferente do restante do backend que usa o SDK do Vertex diretamente).
const googleAuth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });

if (!PROJECT_ID) {
  console.error('ERRO: defina GCP_PROJECT_ID no arquivo .env do servidor.');
  process.exit(1);
}

// Autenticação: usa o arquivo apontado por GOOGLE_APPLICATION_CREDENTIALS (Service Account JSON)
const vertexAI = new VertexAI({ project: PROJECT_ID, location: LOCATION });

app.get('/health', (_req, res) => {
  res.json({ ok: true, model: MODEL_NAME, project: PROJECT_ID, location: LOCATION });
});

/**
 * Espera receber do frontend exatamente o que o AIService já monta hoje:
 * { contents, systemInstruction, config: { maxOutputTokens, ... } }
 * Isso evita reescrever toda a lógica de prepareHistory que já existe no cliente.
 */
app.post('/api/generate', async (req, res) => {
  try {
    const { contents, systemInstruction, config } = req.body || {};

    if (!contents || !Array.isArray(contents)) {
      return res.status(400).json({ error: 'INVALID_REQUEST', message: 'Campo "contents" é obrigatório e deve ser um array.' });
    }

    const generativeModel = vertexAI.getGenerativeModel({
      model: MODEL_NAME,
      generationConfig: {
        maxOutputTokens: config?.maxOutputTokens || 3000,
        temperature: config?.temperature,
        topP: config?.topP,
        topK: config?.topK,
        // Suporta saída JSON estruturada (usado nas telas de criação de item/missão)
        responseMimeType: config?.responseMimeType,
        responseSchema: config?.responseSchema,
      },
      systemInstruction: systemInstruction ? { role: 'system', parts: [{ text: systemInstruction }] } : undefined,
    });

    const result = await generativeModel.generateContent({ contents });

    const response = result.response;
    const candidate = response?.candidates?.[0];
    const text = candidate?.content?.parts?.map(p => p.text || '').join('') || '';
    const finishReason = candidate?.finishReason;

    res.json({
      text,
      candidates: response?.candidates || [],
      finishReason,
    });
  } catch (error) {
    console.error('Erro ao chamar Vertex AI:', error?.message || error);

    const status = error?.code || error?.status || 500;
    res.status(typeof status === 'number' ? status : 500).json({
      error: 'VERTEX_AI_ERROR',
      message: error?.message || 'Erro desconhecido ao chamar o Vertex AI.',
    });
  }
});

const server = http.createServer(app);

// Relay de voz (Live API). O navegador conecta em ws://SEU_BACKEND/live
// e nunca fala diretamente com o Google — o backend autentica com a Service Account
// e repassa (proxy) as mensagens de áudio nos dois sentidos.
const wss = new WebSocketServer({ server, path: '/live' });

wss.on('connection', async (clientWs) => {
  let upstreamWs = null;
  const queuedFromClient = []; // Mensagens que chegam do navegador antes do upstream abrir

  try {
    const authClient = await googleAuth.getClient();
    const accessTokenResponse = await authClient.getAccessToken();
    const accessToken = accessTokenResponse?.token || accessTokenResponse;

    const upstreamUrl = `wss://${LOCATION}-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent`;
    upstreamWs = new WebSocket(upstreamUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    upstreamWs.on('open', () => {
      // Libera qualquer mensagem (setup, áudio) que o cliente já tinha mandado
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
      console.error('Erro no upstream do Vertex Live:', err?.message || err);
      if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1011, 'upstream_error');
    });
  } catch (err) {
    console.error('Falha ao autenticar/abrir relay de voz:', err?.message || err);
    clientWs.close(1011, 'auth_failed');
    return;
  }

  // Navegador -> backend -> Google
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

// Expõe pro frontend qual é o nome completo do modelo de voz a usar na mensagem de setup
app.get('/live-config', (_req, res) => {
  res.json({
    model: `projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${MODEL_LIVE}`,
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Servidor VOIDY (Vertex AI) rodando na porta ${PORT}`);
  console.log(`Projeto: ${PROJECT_ID} | Região: ${LOCATION} | Modelo texto: ${MODEL_NAME} | Modelo voz: ${MODEL_LIVE}`);
  console.log(`Relay de voz disponível em ws://localhost:${PORT}/live`);
});
