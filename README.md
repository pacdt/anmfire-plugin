# 🎌 AnimeFire – SkyStream Plugin

Plugin para o app [SkyStream](https://github.com/akashdh11/skystream) que raspa o **AnimeFire.io** em tempo real, com suporte a dublado, legendado e resolução automática de links Blogger.

---

## ✨ Funcionalidades

| Função | O que faz |
|---|---|
| `getHome` | Home com Trending (últimos lançamentos), Dublados e Legendados |
| `search` | Busca por nome direto no site (`/pesquisar?q=`) |
| `load` | Detalhes do anime + lista completa de episódios sob demanda |
| `loadStreams` | Resolve o link do episódio com **dupla verificação** MP4 + Blogger |

**Configurações disponíveis no app (Settings → Plugins → AnimeFire):**
- 🎭 Tipo de Conteúdo: `Todos / Dublado / Legendado`
- 📺 Qualidade Preferida: `1080p / 720p / 480p / 360p`

---

## 🚀 Instalação Rápida

1. Faça o deploy no GitHub (veja abaixo)
2. Abra o SkyStream → **Extensions** → **Add Source**
3. Cole a URL:
```
https://raw.githubusercontent.com/pacdt/anmfire-plugin/main/repo.json
```

---

## 🛠️ Setup para Desenvolvedores

### Pré-requisitos
- Node.js 18+
- Git
- `npm install -g skystream-cli`

### Estrutura do Projeto
```
animefire-skystream/
├── repo.json          ← Índice do repositório SkyStream
├── dist/              ← Artefatos gerados pelo `skystream deploy`
├── animefire/
│   ├── plugin.js       ← Lógica completa do scraper
│   └── plugin.json     ← Manifesto do plugin (exigido pelo CLI)
├── .github/
│   └── workflows/
│       └── deploy.yml  ← CI/CD automático via GitHub Actions
└── README.md
```

> **Atenção:** o CLI exige `plugin.json`, não `manifest.json`. O arquivo `manifest.json` foi removido.

### Testar Localmente

```bash
# Inicializar o projeto pelo CLI (primeira vez)
skystream init "anime-br" --package-name com.animebr.animefire --plugin-name "AnimeFire"

# Copiar plugin.js e plugin.json para a pasta gerada, depois:

# Home
skystream test --path animefire -f getHome

# Busca
skystream test --path animefire -f search -q "Naruto"

# Detalhes + episódios
skystream test --path animefire -f load -q "https://animefire.io/animes/naruto-todos-os-episodios"

# Stream com mp4 direto
skystream test --path animefire -f loadStreams -q "https://animefire.io/animes/naruto/1"

# Stream com link Blogger
skystream test --path animefire -f loadStreams -q "https://animefire.io/animes/one-piece/1"
```

### Deploy

```bash
skystream deploy --url https://raw.githubusercontent.com/pacdt/anmfire-plugin/main
```

Isso gera ou atualiza:

- `repo.json`
- `dist/plugins.json`
- `dist/com.animebr.animefire.sky`

O GitHub Actions também pode executar o deploy automaticamente a cada push na branch `main`.

---

## 🔍 Arquitetura do `loadStreams`

### Formato da API de vídeo

Endpoint: `GET https://animefire.io/video/{slug}/{numero}`

Dois formatos possíveis na resposta:

```jsonc
// Caso A — Vídeo MP4 direto (sem token)
{
  "token": null,
  "data": [
    { "src": "https://cdn.../ep1.mp4", "label": "HD" },
    { "src": "https://cdn.../ep1_sd.mp4", "label": "SD" }
  ]
}

// Caso B — Vídeo Blogger (com token)
// Alguns episódios têm token E data[] simultaneamente
{
  "token": "https://www.blogger.com/video.g?token=AD6v5dz...",
  "data": [
    { "src": "https://cdn.../ep1.mp4", "label": "HD" }  // ← pode existir!
  ]
}
```

### Fluxo com dupla verificação

```
GET /video/{slug}/{ep}
         │
         ▼
  parseVideoResponse()
  ┌──────────────────────────────────────────┐
  │  bloggerToken  ←  campo "token"          │
  │  mp4Urls[]     ←  campo "data[].src"     │
  └──────────────────────────────────────────┘
         │
         ├─── mp4Urls[] não vazio?
         │      └─ SIM → StreamResult[] ordenados por qualidade preferida
         │                (adicionados PRIMEIRO — maior prioridade)
         │
         └─── bloggerToken existe?
                └─ SIM → resolveBloggerUrl()  (roda SEMPRE, independente do data[])
                            │
                            ▼
                     fetch blogger.com/video.g?token=...
                            │
                            ▼
                  Estratégias em ordem:
                  1. VIDEO_CONFIG = { streams: [{play_url, format_id}] }
                  2. "play_url" dispersos no HTML
                  3. URLs .mp4 diretas no HTML
                  4. redirector.googlevideo.com
                            │
                            ▼
                  StreamResult[] adicionados DEPOIS dos mp4
                  (sem duplicatas de URL)
```

> **Por que dupla verificação?** Alguns episódios fornecem token Blogger **e** links mp4 em `data[]` simultaneamente. Ignorar um dos dois significa perder fontes alternativas para o usuário.

### Mapeamento de qualidade do Blogger

| `format_id` | Qualidade |
|:-----------:|-----------|
| 37 | 1080p |
| 22 / 136 / 137 | 720p |
| 59 / 78 / 135 | 480p |
| 18 | 360p |

---

## 🐛 Depuração

Logs no app: **Settings → Logs** — filtre por `[AnimeFire]`.

```
[AnimeFire] loadStreams: {slug} ep {num}
[AnimeFire] API resposta → token: sim/não | mp4 em data[]: N
[AnimeFire] Resolvendo Blogger: https://blogger.com/video.g?token=...
[AnimeFire] Blogger: VIDEO_CONFIG encontrado, N streams
[AnimeFire] Blogger retornou N stream(s)
[AnimeFire] Total de streams: N
```

### Problemas Comuns

**`"API de vídeo sem resposta"`**
→ Verifique se `https://animefire.io/video/{slug}/{ep}` responde no browser. O domínio pode ter mudado novamente.

**`"Blogger: nenhum stream encontrado"`**
→ O log imprime os primeiros 300 chars do HTML retornado pelo Blogger. Analise o trecho e ajuste `resolveBloggerUrl()` conforme o novo padrão encontrado.

**`"Falha na busca"`**
→ Teste `https://animefire.io/pesquisar?q=naruto` no browser. Se o endpoint mudou, ajuste a função `search()`.

**Episódios não aparecem**
→ O site pode estar carregando a lista de episódios via JavaScript dinâmico. Inspecione a aba **Network** do DevTools no AnimeFire, filtre por `XHR/Fetch` e identifique o endpoint que retorna os episódios — depois adapte `parseEpisodeList()`.

---

## 📋 Notas Técnicas

| Item | Detalhe |
|---|---|
| Runtime | QuickJS — sem DOM, sem `window`, sem `localStorage` |
| API HTTP | `http_get(url, headers)` nativo do runtime; `fetch()` como fallback (Node 18+) |
| Shim | `httpRaw()` tenta `http_get` primeiro, cai para `fetch` automaticamente |
| Manifesto | `animefire/plugin.json` (CLI exige esse nome, não `manifest.json`) |
| `manifest.baseUrl` | Lido do `animefire/plugin.json`; pode ser sobrescrito pelo usuário no app |
| Dependências | Nenhuma — plugin é um único `.js` self-contained |
| Configurações | Acessíveis via `settings.{id}` após `registerSettings()` |
| Domínios | `animefire.io` (principal), `animefire.plus` (redirect), `blogger.com` (vídeos) |
