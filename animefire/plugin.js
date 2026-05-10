/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║           AnimeFire – SkyStream Plugin                       ║
 * ║  Fonte: animefire.io  |  Dublado + Legendado                 ║
 * ║  Compatível com SkyStream Gen 2 (QuickJS Runtime)            ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * FUNÇÕES IMPLEMENTADAS:
 *   getHome()      → Home com categorias (Trending, Dublados, Legendados)
 *   search(query)  → Busca em tempo real no site
 *   load(url)      → Detalhes do anime + lista de episódios
 *   loadStreams(url)→ Link direto do episódio (resolve Blogger → .mp4)
 */

(function () {
  "use strict";

  // ══════════════════════════════════════════════════════════════
  //  CONFIGURAÇÃO
  // ══════════════════════════════════════════════════════════════

  // manifest.baseUrl é definido pelo plugin.json e pode ser sobrescrito
  // pelo usuário no app (mirrors, proxies). animefire.plus redireciona para .io.
  const BASE      = manifest.baseUrl; // "https://animefire.io"
  const VIDEO_API = BASE + "/video";
  
  // API estática via CDN (jsDelivr) — catálogo, busca e metadados
  const CDN = "https://cdn.jsdelivr.net/gh/pacdt/anm-db@main/api_dist/v1";

  /** Headers que imitam um browser real para evitar bloqueios */
  const HEADERS = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" +
      " (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Referer": BASE + "/",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
  };

  const JSON_HEADERS = Object.assign({}, HEADERS, {
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
  });

  // ══════════════════════════════════════════════════════════════
  //  CAMADA DE COMPATIBILIDADE HTTP
  //  O runtime do app expõe http_get(url, headers) → Promise<string>
  //  O mock do skystream-cli também usa http_get.
  //  Usamos http_get como primário e fetch() como fallback
  //  para rodar tanto no CLI quanto no app real.
  // ══════════════════════════════════════════════════════════════

  /**
   * Faz uma requisição GET e retorna o corpo como texto.
   * Usa http_get (runtime nativo) com fallback para fetch (Node/browser).
   *
   * @param {string} url
   * @param {Object} headers
   * @returns {Promise<string|null>}
   */
  async function httpRaw(url, headers) {
    // ── Tenta http_get (runtime SkyStream) ────────────────────
    if (typeof http_get === "function") {
      try {
        var result = await http_get(url, headers);
        // http_get pode retornar string diretamente ou { body, status }
        if (typeof result === "string") return result;
        if (result && typeof result === "object") {
          if (result.status && result.status >= 400) return null;
          return result.body || result.text || result.data || null;
        }
        return null;
      } catch (e) {
        console.error("[AnimeFire] http_get erro: " + String(e));
        return null;
      }
    }

    // ── Fallback: fetch (Node 18+ / browser) ──────────────────
    if (typeof fetch === "function") {
      try {
        var res = await fetch(url, { method: "GET", headers: headers });
        if (!res.ok) return null;
        return await res.text();
      } catch (e) {
        console.error("[AnimeFire] fetch erro: " + String(e));
        return null;
      }
    }

    console.error("[AnimeFire] Nenhuma API HTTP disponível (nem http_get nem fetch)");
    return null;
  }

  /** Mapeamento de format_id do Blogger para rótulo de qualidade */
  const BLOGGER_QUALITY = {
    18: "360p",
    22: "720p",
    37: "1080p",
    59: "480p",
    78: "480p",
    135: "480p",
    136: "720p",
    137: "1080p",
  };

  // ══════════════════════════════════════════════════════════════
  //  CONFIGURAÇÕES DO USUÁRIO (visíveis em Settings > Plugins)
  // ══════════════════════════════════════════════════════════════

  registerSettings([
    {
      id: "content_type",
      name: "Tipo de Conteúdo",
      type: "select",
      options: ["Todos", "Dublado", "Legendado"],
      default: "Todos",
    },
    {
      id: "preferred_quality",
      name: "Qualidade Preferida",
      type: "select",
      options: ["1080p", "720p", "480p", "360p"],
      default: "720p",
    },
  ]);

  // ══════════════════════════════════════════════════════════════
  //  UTILITÁRIOS HTTP
  // ══════════════════════════════════════════════════════════════

  /**
   * Busca HTML de uma URL.
   * @param {string} url
   * @param {Object} [extra] - Headers adicionais
   * @returns {Promise<string|null>}
   */
  async function httpGet(url, extra) {
    var hdrs = extra ? Object.assign({}, HEADERS, extra) : HEADERS;
    return await httpRaw(url, hdrs);
  }

  /**
   * Busca JSON de uma URL.
   * @param {string} url
   * @returns {Promise<any|null>}
   */
  async function httpGetJson(url) {
    var text = await httpRaw(url, JSON_HEADERS);
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (e) {
      console.error("[AnimeFire] JSON parse erro em " + url + ": " + String(e));
      return null;
    }
  }

  // ══════════════════════════════════════════════════════════════
  //  PARSERS HTML
  // ══════════════════════════════════════════════════════════════

  /**
   * Extrai cards de anime de qualquer página do AnimeFire.
   *
   * Estrutura esperada no HTML:
   *   <article class="min_video_card ...">
   *     <a href="/animes/slug-todos-os-episodios">
   *       <img data-src="https://cdn.../poster.jpg">
   *       <h3 class="animeTitle">Título do Anime</h3>
   *     </a>
   *   </article>
   *
   * @param {string} html
   * @returns {MultimediaItem[]}
   */
  function parseAnimeCards(html) {
    if (!html) return [];

    var items = [];
    var seen = {};
    var ctFilter = (typeof settings !== "undefined" && settings.content_type) || "Todos";

    /**
     * Regex que captura, em sequência dentro de uma tag <a>:
     *   Grupo 1: href="/animes/slug..."
     *   Grupo 2: data-src ou src da imagem (URL de poster)
     *   Grupo 3: texto do título (h3, span, p com classe de título)
     *
     * A regex usa [\s\S]{0,500}? para permitir quebras de linha entre elementos.
     */
    var re = /href="(\/animes\/[^"?#]+)"[^>]*>[\s\S]{0,500}?(?:data-src|src)="(https?:\/\/[^"]+)"[\s\S]{0,300}?<(?:h[1-6]|span|p)[^>]*(?:class="[^"]*(?:title|Title|nome|name)[^"]*")?[^>]*>\s*([^<\n]{2,80})\s*</gi;

    var m;
    while ((m = re.exec(html)) !== null) {
      var path   = m[1];          // /animes/one-piece-todos-os-episodios
      var poster = m[2];          // https://cdn.../poster.jpg
      var title  = m[3].trim();   // One Piece

      if (!title || !poster || seen[path]) continue;
      seen[path] = true;

      // Detecta se é dublado pelo slug ou título
      var isDubbed = path.indexOf("dublado") !== -1 || title.toLowerCase().indexOf("dublado") !== -1;

      // Filtra conforme configuração do usuário
      if (ctFilter === "Dublado" && !isDubbed) continue;
      if (ctFilter === "Legendado" && isDubbed) continue;

      var fullUrl = BASE + path;

      items.push(new MultimediaItem({
        title:     title,
        url:       fullUrl,
        posterUrl: poster,
        type:      "anime",
        dubStatus: isDubbed ? "dubbed" : "subbed",
      }));
    }

    // Fallback: regex mais simples se a principal não capturou nada
    if (items.length === 0) {
      var re2 = /href="(\/animes\/[^"\/]+(?:-todos-os-episodios)?)"[^>]*>/gi;
      while ((m = re2.exec(html)) !== null) {
        var p = m[1];
        if (seen[p]) continue;
        seen[p] = true;
        var slug = p.replace("/animes/", "").replace("-todos-os-episodios", "");
        var t = slug.replace(/-/g, " ").replace(/\b\w/g, function(c) { return c.toUpperCase(); });
        items.push(new MultimediaItem({
          title:     t,
          url:       BASE + p,
          posterUrl: "",
          type:      "anime",
        }));
      }
    }

    return items;
  }

  /**
   * Extrai cards da home page do AnimeFire.
   * A home geralmente mostra os últimos episódios lançados.
   *
   * URL dos cards na home pode ser /animes/{slug}/{numero}
   * Precisamos normalizar para /animes/{slug}-todos-os-episodios
   *
   * @param {string} html
   * @returns {MultimediaItem[]}
   */
  function parseHomeCards(html) {
    if (!html) return [];

    var items = [];
    var seen  = {};

    /**
     * Padrão da home: card de episódio com link e poster.
     * Captura: slug do anime (sem número de episódio) + imagem + título.
     */
    var re = /href="\/animes\/([^"\/\d][^"\/]*?)(?:\/\d+)?"[^>]*>[\s\S]{0,400}?(?:data-src|src)="(https?:\/\/cdn[^"]+)"[\s\S]{0,300}?<(?:h[1-6]|[ab])[^>]*>\s*([^<\n]{2,80})\s*</gi;

    var m;
    while ((m = re.exec(html)) !== null) {
      var slug   = m[1];
      var poster = m[2];
      var title  = m[3].trim();

      if (!title || !poster || seen[slug] || /^\d+$/.test(slug)) continue;
      seen[slug] = true;

      items.push(new MultimediaItem({
        title:     title,
        url:       BASE + "/animes/" + slug + "-todos-os-episodios",
        posterUrl: poster,
        type:      "anime",
      }));

      if (items.length >= 20) break;
    }

    return items;
  }

  /**
   * Extrai lista de episódios da página de detalhes do anime.
   *
   * AnimeFire usa links do tipo:
   *   <a href="/animes/one-piece/1">Episódio 1</a>
   *   <a href="/animes/one-piece/2">Episódio 2</a>
   *   ...em um container de lista/accordion.
   *
   * @param {string} html
   * @param {string} baseAnimeUrl - URL original do anime (para extrair slug)
   * @returns {Episode[]}
   */
  function parseEpisodeList(html, baseAnimeUrl) {
    if (!html) return [];

    var episodes = [];
    var seen     = {};

    // Extrai o slug base da URL do anime
    var slugMatch = baseAnimeUrl.match(/\/animes\/([^\/\?#]+?)(?:-todos-os-episodios)?(?:\/|$)/);
    var animeSlug = slugMatch ? slugMatch[1] : null;

    /**
     * Captura: /animes/{slug}/{número}
     * Grupo 1: path completo
     * Grupo 2: slug
     * Grupo 3: número do episódio
     */
    var re = /href="(\/animes\/([^"\/]+)\/(\d+))"/gi;

    var m;
    while ((m = re.exec(html)) !== null) {
      var fullPath = m[1];
      var slug     = m[2];
      var epNum    = parseInt(m[3], 10);

      if (seen[fullPath] || isNaN(epNum)) continue;

      // Só inclui episódios do mesmo anime (slug compatível)
      if (animeSlug && slug.indexOf(animeSlug.split("-")[0]) === -1) continue;

      seen[fullPath] = true;

      episodes.push(new Episode({
        name:    "Episódio " + epNum,
        url:     BASE + fullPath,
        season:  1,
        episode: epNum,
      }));
    }

    // Ordena por número de episódio (crescente)
    episodes.sort(function(a, b) { return a.episode - b.episode; });

    return episodes;
  }

  /**
   * Extrai metadados completos da página de detalhes do anime.
   *
   * @param {string} html
   * @param {string} url - URL original da página
   * @returns {MultimediaItem}
   */
  function parseAnimeDetail(html, url) {
    if (!html) return null;

    // ── Título ─────────────────────────────────────────────────
    var titleM =
      html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i) ||
      html.match(/<h1[^>]*class="[^"]*(?:title|titulo|animeTitle)[^"]*"[^>]*>\s*([^<]+)\s*<\/h1>/i) ||
      html.match(/<title>([^<]+)<\/title>/i);
    var title = titleM
      ? titleM[1].trim().replace(/\s*[\|\-–]\s*AnimeFire.*$/i, "").trim()
      : "Desconhecido";

    // ── Poster ─────────────────────────────────────────────────
    var imgM =
      html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i) ||
      html.match(/<img[^>]+(?:id|class)="[^"]*(?:capa|poster|cover|thumb)[^"]*"[^>]+(?:data-src|src)="([^"]+)"/i) ||
      html.match(/<img[^>]+(?:data-src|src)="(https?:\/\/[^"]+\.(?:jpg|png|webp)[^"]*)"[^>]+(?:id|class)="[^"]*(?:capa|poster)[^"]*"/i);
    var posterUrl = imgM ? imgM[1] : "";

    // ── Sinopse ────────────────────────────────────────────────
    var synM =
      html.match(/<(?:div|p)[^>]+class="[^"]*(?:sinopse|synopsis|descri[çc][aã]o|description)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|p)>/i) ||
      html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i);
    var description = synM
      ? synM[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()
      : "";

    // ── Nota / Score ───────────────────────────────────────────
    var scoreM = html.match(/(?:<span[^>]*>|"nota"|"score"|"rating")[\s\S]{0,30}?([\d]{1,2}(?:[.,]\d)?)\s*(?:<\/span>|\/10)/i);
    var score = scoreM ? parseFloat(scoreM[1].replace(",", ".")) : undefined;

    // ── Status ─────────────────────────────────────────────────
    var statusM = html.match(/(?:status|situa[çc][aã]o)[^>]{0,30}>\s*([^<]{3,30})\s*</i);
    var rawStatus = statusM ? statusM[1].trim().toLowerCase() : "";
    var status =
      rawStatus.indexOf("complet") !== -1 ? "completed" :
      rawStatus.indexOf("andamento") !== -1 || rawStatus.indexOf("lançando") !== -1 ? "ongoing" :
      undefined;

    // ── Ano ────────────────────────────────────────────────────
    var yearM = html.match(/(?:ano|year|estreia)[^>]{0,30}>[\s\S]{0,20}?(20\d{2}|19\d{2})/i);
    var year = yearM ? parseInt(yearM[1], 10) : undefined;

    // ── Género (opcional) ──────────────────────────────────────
    // AnimeFire usa links /genero/{slug}
    var genreRe  = /href="[^"]*\/genero\/[^"]*">([^<]+)<\/a>/gi;
    var genres   = [];
    var gm;
    while ((gm = genreRe.exec(html)) !== null) {
      genres.push(gm[1].trim());
    }

    // ── Tipo: dublado ou legendado ─────────────────────────────
    var isDubbed = url.indexOf("dublado") !== -1 ||
      (html.indexOf("Dublado") !== -1 && html.indexOf("Legendado") === -1);

    // ── Episódios ──────────────────────────────────────────────
    var episodes = parseEpisodeList(html, url);

    console.log(
      "[AnimeFire] load(): " + title +
      " | " + episodes.length + " eps" +
      " | " + (isDubbed ? "Dublado" : "Legendado")
    );

    return new MultimediaItem({
      title:       title,
      url:         url,
      posterUrl:   posterUrl,
      description: description,
      score:       score,
      year:        year,
      status:      status,
      type:        "anime",
      dubStatus:   isDubbed ? "dubbed" : "subbed",
      episodes:    episodes,
    });
  }

  // ══════════════════════════════════════════════════════════════
  //  API DE VÍDEO DO ANIMEFIRE
  // ══════════════════════════════════════════════════════════════

  /**
   * Analisa a resposta JSON da API de vídeo do AnimeFire.
   *
   * FORMATO CONFIRMADO:
   *   Caso A – Vídeo Blogger:
   *     { token: "https://blogger.com/video.g?token=...", data: null ou ausente }
   *
   *   Caso B – Vídeo MP4 direto:
   *     { token: null ou ausente, data: [ { src: "https://....mp4", label: "HD" }, ... ] }
   *
   *   Regra de dupla verificação:
   *     Mesmo quando `token` existe, varremos `data[]` procurando .mp4
   *     (alguns episódios podem oferecer ambos). Se achar mp4 em data[],
   *     priorizamos ele — evita depender do resolver do Blogger.
   *
   * @param {any} json - objeto JSON já parseado
   * @returns {{ bloggerToken: string|null, mp4Urls: {src:string,label:string}[] }}
   */
  function parseVideoResponse(json) {
    var result = { bloggerToken: null, mp4Urls: [] };
    if (!json) return result;

    // ── 1. Extrai token do Blogger ─────────────────────────────
    var token = json.token;
    if (token && typeof token === "string" && token.indexOf("http") === 0) {
      result.bloggerToken = token;
    }

    // ── 2. Extrai URLs .mp4 de data[] ─────────────────────────
    //   data[] pode ser:
    //     [ { src: "https://...", label: "HD" } ]    ← mais comum
    //     [ "https://..." ]                           ← fallback simples
    var arr = json.data;
    if (Array.isArray(arr)) {
      for (var i = 0; i < arr.length; i++) {
        var item = arr[i];
        var src  = null;
        var lbl  = "Auto";

        if (typeof item === "string") {
          src = item;
        } else if (item && typeof item === "object") {
          src = item.src || item.url || item.video || item.link || null;
          lbl = item.label || item.quality || item.qualidade || lbl;
        }

        if (src && typeof src === "string" && src.indexOf("http") === 0) {
          // Aceita qualquer link — mp4 explícito ou não
          result.mp4Urls.push({ src: src, label: String(lbl) });
        }
      }
    }

    return result;
  }

  // ══════════════════════════════════════════════════════════════
  //  RESOLVER DE LINKS BLOGGER
  // ══════════════════════════════════════════════════════════════

  /**
   * Resolve uma URL do tipo blogger.com/video.g?token=... para MP4 real.
   *
   * COMO FUNCIONA:
   *   1. Faz fetch da URL do Blogger
   *   2. A resposta é HTML com um <script> contendo VIDEO_CONFIG = {...}
   *   3. VIDEO_CONFIG.streams é um array de { play_url, format_id }
   *   4. format_id mapeia para qualidade (18=360p, 22=720p, 37=1080p...)
   *   5. Retorna streams ordenados pela qualidade preferida do usuário
   *
   * Fallbacks adicionais caso VIDEO_CONFIG não seja encontrado:
   *   - Busca por "play_url" dispersos no HTML
   *   - Busca por URLs .mp4 diretas
   *   - Busca por redirector.googlevideo.com
   *
   * @param {string} bloggerUrl
   * @returns {Promise<StreamResult[]>}
   */
  async function resolveBloggerUrl(bloggerUrl) {
    console.log("[AnimeFire] Resolvendo Blogger: " + bloggerUrl.slice(0, 80) + "...");

    var html = await httpGet(bloggerUrl, {
      "Referer": BASE + "/",
      "Accept":  "text/html,*/*",
    });

    if (!html) {
      console.log("[AnimeFire] Blogger: sem resposta");
      return [];
    }

    // ── Estratégia 1: VIDEO_CONFIG = { ... } ──────────────────
    var cfgMatch = html.match(/VIDEO_CONFIG\s*=\s*(\{[\s\S]*?\})\s*;/);
    if (cfgMatch) {
      try {
        var cfg = JSON.parse(cfgMatch[1]);
        if (Array.isArray(cfg.streams) && cfg.streams.length > 0) {
          console.log("[AnimeFire] Blogger: VIDEO_CONFIG encontrado, " + cfg.streams.length + " streams");

          var preferred = (typeof settings !== "undefined" && settings.preferred_quality) || "720p";

          // Ordena: qualidade preferida primeiro, depois decrescente
          var sorted = cfg.streams.slice().sort(function(a, b) {
            var qa = BLOGGER_QUALITY[a.format_id] || "0p";
            var qb = BLOGGER_QUALITY[b.format_id] || "0p";
            if (qa === preferred && qb !== preferred) return -1;
            if (qb === preferred && qa !== preferred) return 1;
            return (b.format_id || 0) - (a.format_id || 0);
          });

          return sorted
            .filter(function(s) { return s.play_url && s.play_url.indexOf("http") === 0; })
            .map(function(s) {
              return new StreamResult({
                url:     s.play_url,
                quality: BLOGGER_QUALITY[s.format_id] || ("format-" + s.format_id),
                headers: { "Referer": "https://www.blogger.com/" },
              });
            });
        }
      } catch (parseErr) {
        console.error("[AnimeFire] Blogger: erro ao parsear VIDEO_CONFIG:", String(parseErr));
      }
    }

    // ── Estratégia 2: "play_url" dispersos no HTML ─────────────
    var playUrls  = [];
    var formatIds = [];
    var puRe = /"play_url"\s*:\s*"(https?:\/\/[^"]+)"/g;
    var fiRe = /"format_id"\s*:\s*(\d+)/g;
    var pm, fm;
    while ((pm = puRe.exec(html)) !== null) playUrls.push(pm[1]);
    while ((fm = fiRe.exec(html)) !== null) formatIds.push(parseInt(fm[1], 10));

    if (playUrls.length > 0) {
      console.log("[AnimeFire] Blogger: " + playUrls.length + " play_url(s) encontradas (estratégia 2)");
      return playUrls.map(function(u, i) {
        return new StreamResult({
          url:     u,
          quality: formatIds[i] ? (BLOGGER_QUALITY[formatIds[i]] || "Auto") : ("Stream " + (i + 1)),
          headers: { "Referer": "https://www.blogger.com/" },
        });
      });
    }

    // ── Estratégia 3: URL .mp4 direta no HTML ──────────────────
    var mp4Re  = /(https?:\/\/[^\s"'<>]+\.mp4(?:\?[^\s"'<>]*)?)/;
    var mp4M   = html.match(mp4Re);
    if (mp4M) {
      console.log("[AnimeFire] Blogger: MP4 direto encontrado (estratégia 3)");
      return [new StreamResult({
        url:     mp4M[1],
        quality: "Auto",
        headers: { "Referer": "https://www.blogger.com/" },
      })];
    }

    // ── Estratégia 4: redirector.googlevideo.com ──────────────
    var gvRe = /(https?:\/\/redirector\.googlevideo\.com\/[^\s"'<>]+)/;
    var gvM  = html.match(gvRe);
    if (gvM) {
      console.log("[AnimeFire] Blogger: redirector.googlevideo.com encontrado (estratégia 4)");
      return [new StreamResult({
        url:     gvM[1],
        quality: "Auto",
        headers: { "Referer": "https://www.blogger.com/" },
      })];
    }

    console.log("[AnimeFire] Blogger: nenhum stream encontrado. HTML snippet: " + html.slice(0, 300));
    return [];
  }

  // ══════════════════════════════════════════════════════════════
  //  FUNÇÕES PRINCIPAIS (Contrato SkyStream)
  // ══════════════════════════════════════════════════════════════

  // ══════════════════════════════════════════════════════════════
  //  HELPERS DA CDN
  // ══════════════════════════════════════════════════════════════

  /**
   * Converte um item resumido do CDN (all.json / new_animes.json)
   * para um MultimediaItem do SkyStream.
   *
   * Formato CDN:
   *   { title, slug, image, score, type }          ← all.json
   *   { title, slug, image, score, type, updated_at } ← new_animes.json
   *
   * @param {Object} item
   * @returns {MultimediaItem}
   */
  function cdnItemToMedia(item) {
    return new MultimediaItem({
      title:     item.title || item.nome || item.slug,
      url:       BASE + "/animes/" + item.slug + "-todos-os-episodios",
      posterUrl: item.image || item.imagem || "",
      type:      "anime",
      score:     item.score || undefined,
      dubStatus: item.type === "dublado" ? "dubbed" : "subbed",
    });
  }

  /**
   * Filtra lista do CDN pelo tipo de conteúdo configurado pelo usuário.
   * @param {Object[]} list
   * @returns {Object[]}
   */
  function filterByType(list) {
    var ct = (typeof settings !== "undefined" && settings.content_type) || "Todos";
    if (ct === "Todos") return list;
    var want = ct === "Dublado" ? "dublado" : "legendado";
    return list.filter(function(i) { return i.type === want; });
  }

  // ══════════════════════════════════════════════════════════════
  //  FUNÇÕES PRINCIPAIS (Contrato SkyStream)
  // ══════════════════════════════════════════════════════════════

  /**
   * getHome – Retorna categorias para a tela inicial via CDN.
   *
   * Categorias:
   *   "Trending"   → new_animes.json  (últimos atualizados → Hero Carousel)
   *   "Dublados"   → all.json filtrado por type==="dublado"  (primeiros 40)
   *   "Legendados" → all.json filtrado por type==="legendado" (primeiros 40)
   *
   * Três requests paralelos para não bloquear a UI.
   *
   * @param {Function} cb
   */
  async function getHome(cb) {
    try {
      var ct = (typeof settings !== "undefined" && settings.content_type) || "Todos";

      // Três chamadas em paralelo
      var newReq = httpGetJson(CDN + "/animes/new_animes.json");
      var allReq = (ct === "Todos" || ct === "Dublado" || ct === "Legendado")
        ? httpGetJson(CDN + "/animes/all.json")
        : Promise.resolve(null);

      var newData = await newReq;
      var allData = await allReq;

      var result = {};

      // ── Trending (Hero Carousel) ─────────────────────────────
      if (Array.isArray(newData) && newData.length > 0) {
        var trending = filterByType(newData).map(cdnItemToMedia);
        if (trending.length > 0) result["Trending"] = trending;
      }

      // ── Dublados / Legendados ────────────────────────────────
      if (Array.isArray(allData) && allData.length > 0) {
        if (ct === "Todos" || ct === "Dublado") {
          var dubbed = allData
            .filter(function(i) { return i.type === "dublado"; })
            .slice(0, 40)
            .map(cdnItemToMedia);
          if (dubbed.length > 0) result["Dublados"] = dubbed;
        }
        if (ct === "Todos" || ct === "Legendado") {
          var subbed = allData
            .filter(function(i) { return i.type === "legendado"; })
            .slice(0, 40)
            .map(cdnItemToMedia);
          if (subbed.length > 0) result["Legendados"] = subbed;
        }
      }

      console.log(
        "[AnimeFire] getHome: Trending=" + (result["Trending"] || []).length +
        " Dublados=" + (result["Dublados"] || []).length +
        " Legendados=" + (result["Legendados"] || []).length
      );

      if (Object.keys(result).length === 0) {
        cb({ success: false, error: "CDN sem dados. Tente novamente em instantes." });
        return;
      }

      cb({ success: true, data: result });
    } catch (e) {
      cb({ success: false, error: "getHome: " + String(e) });
    }
  }

  /**
   * search – Busca animes por nome via CDN (filtro client-side).
   *
   * Carrega all.json uma vez e filtra localmente — sem scraping de HTML.
   * Case-insensitive, suporta busca parcial e acento-insensitive.
   *
   * @param {string} query
   * @param {Function} cb
   */
  async function search(query, cb) {
    try {
      var q = (query || "").trim();
      if (q.length === 0) {
        cb({ success: false, error: "Termo de busca vazio." });
        return;
      }

      var allData = await httpGetJson(CDN + "/animes/all.json");
      if (!Array.isArray(allData) || allData.length === 0) {
        cb({ success: false, error: "Catálogo CDN indisponível. Tente novamente." });
        return;
      }

      // Normaliza string removendo acentos para comparação
      function normalize(s) {
        return String(s || "")
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "");
      }

      var qn = normalize(q);

      var filtered = filterByType(allData).filter(function(item) {
        return normalize(item.title || item.slug).indexOf(qn) !== -1;
      });

      console.log("[AnimeFire] search('" + q + "'): " + filtered.length + " resultados");

      cb({ success: true, data: filtered.map(cdnItemToMedia) });
    } catch (e) {
      cb({ success: false, error: "search: " + String(e) });
    }
  }

  /**
   * load – Carrega detalhes + episódios via CDN.
   *
   * A URL recebida é a página do anime:
   *   https://animefire.io/animes/{slug}-todos-os-episodios
   *
   * Fluxo:
   *   1. Extrai o slug da URL
   *   2. Busca CDN /animes/{slug}.json  →  metadados completos + lista de episódios
   *   3. Constrói episode.url apontando para AnimeFire  →  passado ao loadStreams()
   *   4. Fallback: se slug falhar, busca all.json e encontra pelo título
   *
   * @param {string} url
   * @param {Function} cb
   */
  async function load(url, cb) {
    try {
      // ── Extrai slug da URL ────────────────────────────────────
      var slugM = url.match(/\/animes\/([^\/?#]+?)(?:-todos-os-episodios)?(?:\/|$)/);
      if (!slugM) {
        cb({ success: false, error: "URL inválida para load(): " + url });
        return;
      }
      var slug = slugM[1];

      console.log("[AnimeFire] load(): slug=" + slug);

      // ── Busca dados completos no CDN ──────────────────────────
      var data = await httpGetJson(CDN + "/animes/" + slug + ".json");

      if (!data || !data.slug) {
        cb({ success: false, error: "Anime não encontrado no CDN: " + slug });
        return;
      }

      // ── Monta episódios ───────────────────────────────────────
      // O CDN tem { episodes: [{numero, url, nome}] }
      // episode.url do CDN pode ser mp4/blogger direto, MAS
      // passamos a URL do AnimeFire para loadStreams() sempre consultar
      // a API em tempo real (garante link fresco, não expirado do CDN).
      var cdnEpisodes = Array.isArray(data.episodes) ? data.episodes : [];

      var episodes = cdnEpisodes.map(function(ep) {
        return new Episode({
          name:    ep.nome || ep.name || ("Episódio " + ep.numero),
          url:     BASE + "/animes/" + slug + "/" + ep.numero,
          season:  1,
          episode: ep.numero,
        });
      });

      console.log("[AnimeFire] load(): " + episodes.length + " episódios encontrados");

      // ── Monta MultimediaItem ──────────────────────────────────
      var item = new MultimediaItem({
        title:       data.title || data.title_english || data.slug,
        url:         url,
        posterUrl:   data.image || "",
        description: data.synopsis || "",
        score:       data.score   || undefined,
        year:        data.year    || undefined,
        status:      data.status  || undefined,
        type:        "anime",
        dubStatus:   data.type === "dublado" ? "dubbed" : "subbed",
        episodes:    episodes,
      });

      cb({ success: true, data: item });
    } catch (e) {
      cb({ success: false, error: "load: " + String(e) });
    }
  }

  /**
   * loadStreams – Resolve o link de streaming de um episódio.
   *
   * Fluxo com DUPLA VERIFICAÇÃO:
   *   1. GET /video/{slug}/{ep}  →  JSON
   *   2. parseVideoResponse()    →  { bloggerToken, mp4Urls[] }
   *   3. Se mp4Urls[] não vazio  →  usa direto (prioridade máxima)
   *   4. Se bloggerToken existe  →  resolve Blogger  →  streams adicionais
   *   5. Mescla tudo: mp4 direto primeiro, Blogger depois
   *   6. Nunca ignora um dos dois — dupla verificação sempre
   *
   * @param {string} url - URL do episódio: .../animes/{slug}/{numero}
   * @param {Function} cb
   */
  async function loadStreams(url, cb) {
    try {
      // ── Passo 1: Extrai slug e número do episódio ──────────
      var pathM = url.match(/\/animes\/([^\/]+)\/(\d+)(?:\/.*)?$/);
      if (!pathM) {
        cb({ success: false, error: "URL de episódio inválida: " + url });
        return;
      }

      var slug  = pathM[1];   // ex: naruto
      var epNum = pathM[2];   // ex: 1

      console.log("[AnimeFire] loadStreams: " + slug + " ep " + epNum);

      // ── Passo 2: Busca JSON na API de vídeo ───────────────
      var videoApiUrl = VIDEO_API + "/" + slug + "/" + epNum;
      var apiData     = await httpGetJson(videoApiUrl);

      if (!apiData) {
        cb({ success: false, error: "API de vídeo sem resposta para " + slug + "/" + epNum });
        return;
      }

      // ── Passo 3: Parseia resposta ──────────────────────────
      var parsed = parseVideoResponse(apiData);

      console.log(
        "[AnimeFire] API resposta → token: " + (parsed.bloggerToken ? "sim" : "não") +
        " | mp4 em data[]: " + parsed.mp4Urls.length
      );

      var streams = [];

      // ── Passo 4: MP4 direto (prioridade) ──────────────────
      //   Mesmo que haja token, se data[] tem mp4 ele vai primeiro
      if (parsed.mp4Urls.length > 0) {
        var preferred = (typeof settings !== "undefined" && settings.preferred_quality) || "720p";

        // Ordena: qualidade preferida primeiro
        var sorted = parsed.mp4Urls.slice().sort(function(a, b) {
          var matchA = a.label.toLowerCase().indexOf(preferred.replace("p", "")) !== -1;
          var matchB = b.label.toLowerCase().indexOf(preferred.replace("p", "")) !== -1;
          if (matchA && !matchB) return -1;
          if (matchB && !matchA) return 1;
          return 0;
        });

        for (var i = 0; i < sorted.length; i++) {
          streams.push(new StreamResult({
            url:     sorted[i].src,
            quality: sorted[i].label,
            headers: { "Referer": BASE + "/" },
          }));
        }
      }

      // ── Passo 5: Blogger (sempre verifica se token existe) ─
      //   DUPLA VERIFICAÇÃO: roda mesmo que já tenhamos mp4 em data[]
      //   Os streams do Blogger são adicionados depois dos mp4
      if (parsed.bloggerToken) {
        console.log("[AnimeFire] Resolvendo Blogger como fonte adicional...");
        var bloggerStreams = await resolveBloggerUrl(parsed.bloggerToken);

        if (bloggerStreams.length > 0) {
          console.log("[AnimeFire] Blogger retornou " + bloggerStreams.length + " stream(s)");
          for (var j = 0; j < bloggerStreams.length; j++) {
            // Evita duplicar exata mesma URL
            var alreadyHas = false;
            for (var k = 0; k < streams.length; k++) {
              if (streams[k].url === bloggerStreams[j].url) { alreadyHas = true; break; }
            }
            if (!alreadyHas) streams.push(bloggerStreams[j]);
          }
        }
      }

      // ── Passo 6: Valida resultado ──────────────────────────
      if (streams.length === 0) {
        cb({
          success: false,
          error:   "Nenhum stream encontrado para " + slug + " ep " + epNum +
                   ". token=" + (parsed.bloggerToken ? "sim" : "não") +
                   ", data[]=" + parsed.mp4Urls.length
        });
        return;
      }

      console.log("[AnimeFire] Total de streams: " + streams.length);
      cb({ success: true, data: streams });

    } catch (e) {
      cb({ success: false, error: "loadStreams: " + String(e) });
    }
  }

  // ══════════════════════════════════════════════════════════════
  //  EXPORTAÇÕES (obrigatório para o runtime SkyStream)
  // ══════════════════════════════════════════════════════════════

  globalThis.getHome      = getHome;
  globalThis.search       = search;
  globalThis.load         = load;
  globalThis.loadStreams   = loadStreams;

})();
