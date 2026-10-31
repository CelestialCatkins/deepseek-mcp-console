// ==UserScript==
// @name         MCP 控制台
// @namespace    mcp-console
// @version      1.3.0
// @description  基于 Streamable HTTP 的 MCP 客户端面板，支持 DeepSeek 平台，```mcp 指令通道
// @match        https://chat.deepseek.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    /* ============================================================
     * 00-config.js — 常量、存储层
     * ============================================================ */

    const THEMES = {
        ink: { name: '墨', accent: '#1a1a1a', accent2: '#555', bg: '#fafafa', panel: '#fff', text: '#1a1a1a', sub: '#666', border: '#e5e5e5', code: '#f5f5f5' },
        blue: { name: '靛', accent: '#2563eb', accent2: '#3b82f6', bg: '#f8fafc', panel: '#fff', text: '#0f172a', sub: '#64748b', border: '#e2e8f0', code: '#f1f5f9' },
        green: { name: '松', accent: '#059669', accent2: '#10b981', bg: '#f8faf9', panel: '#fff', text: '#064e3b', sub: '#4b5563', border: '#e5e7eb', code: '#f3f4f6' },
        purple: { name: '紫', accent: '#7c3aed', accent2: '#8b5cf6', bg: '#faf8ff', panel: '#fff', text: '#2e1065', sub: '#6b7280', border: '#e9d5ff', code: '#f5f3ff' },
        orange: { name: '橙', accent: '#ea580c', accent2: '#f97316', bg: '#fffbf7', panel: '#fff', text: '#431407', sub: '#78716c', border: '#fed7aa', code: '#fff7ed' }
    };
    const THEME_KEYS = Object.keys(THEMES);
    const DEFAULT_PALETTE = 'blue';

    const CALL_HISTORY_MAX = 60;
    const TOOLS_CACHE_MS = 10 * 60 * 1000;
    const CALL_TIMEOUT_MS = 30 * 1000;
    const INIT_TIMEOUT_MS = 15 * 1000;
    const POLL_INTERVAL_MS = 2000;
    const MAX_TOOL_PAGES = 20;

    const STORE_SERVERS = 'mcp.servers';
    const STORE_UI_CFG = 'mcp.uicfg';
    const STORE_CALLS = 'mcp.calls';
    const STORE_BALL = 'mcp.ball';
    const STORE_ONBOARD = 'mcp.onboard';

    const RISK_MODE = { ALLOW: 'allow', PARTIAL: 'partial', NEVER: 'never' };

    const DANGER_VERBS = ['delete', 'remove', 'drop', 'truncate', 'destroy', 'kill', 'stop', 'restart', 'exec', 'execute', 'shell', 'run', 'write', 'create', 'insert', 'update', 'alter', 'grant', 'revoke', 'send', 'post', 'put', 'patch'];

    /* ---------- 存储层 ---------- */
    const Store = {
        get(key, def) {
            try {
                const v = GM_getValue(key, null);
                if (v === null || v === undefined) return def;
                return typeof v === 'string' ? JSON.parse(v) : v;
            } catch (e) { return def; }
        },
        set(key, val) {
            try { GM_setValue(key, JSON.stringify(val)); } catch (e) { }
        },
        del(key) { try { GM_deleteValue(key); } catch (e) { } }
    };

    /* ---------- 工具函数 ---------- */
    function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

    function esc(s) {
        if (s === null || s === undefined) return '';
        return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function fmtClock(ts) {
        const d = new Date(ts);
        return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0') + ':' + d.getSeconds().toString().padStart(2, '0');
    }

    function fmtDuration(ms) {
        if (ms < 1000) return ms + 'ms';
        return (ms / 1000).toFixed(1) + 's';
    }

    function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

    function safeJson(str) { try { return JSON.parse(str); } catch (e) { return null; } }

    function toast(msg, type) { UI.showToast(msg, type); }

    function log() { console.log.apply(console, ['[MCP]'].concat(Array.prototype.slice.call(arguments))); }
    function warn() { console.warn.apply(console, ['[MCP]'].concat(Array.prototype.slice.call(arguments))); }

    /* ============================================================
     * 01-mcp-client.js — MCP 客户端
     * ============================================================ */

    const Mcp = (function () {
        const sessions = {}; // serverId -> { sessionId, protocolVersion, tools, toolsAt, serverInfo }

        function headers(server) {
            const h = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
            if (server.headers) {
                for (const k in server.headers) {
                    if (server.headers.hasOwnProperty(k)) h[k] = server.headers[k];
                }
            }
            return h;
        }

        async function parseResponse(res) {
            const ct = (res.headers.get('content-type') || '').toLowerCase();
            if (ct.includes('text/event-stream')) {
                const text = await res.text();
                return parseSse(text);
            }
            const text = await res.text();
            const data = safeJson(text);
            if (data === null) throw new Error('Invalid JSON response');
            return data;
        }

        function parseSse(text) {
            const lines = text.split('\n');
            let lastData = null;
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith('data:')) {
                    const d = trimmed.slice(5).trim();
                    if (d && d !== '[DONE]') {
                        const parsed = safeJson(d);
                        if (parsed) lastData = parsed;
                    }
                }
            }
            if (lastData === null) throw new Error('No data in SSE response');
            return lastData;
        }

        async function request(server, body, extraHeaders, timeoutMs) {
            const url = server.url.replace(/\/+$/, '');
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs || CALL_TIMEOUT_MS);
            try {
                const res = await fetch(url, {
                    method: 'POST',
                    headers: Object.assign({}, headers(server), extraHeaders || {}),
                    body: JSON.stringify(body),
                    signal: controller.signal
                });
                if (!res.ok) {
                    const errText = await res.text().catch(() => '');
                    throw new Error('HTTP ' + res.status + ' ' + res.statusText + (errText ? ': ' + errText.slice(0, 300) : ''));
                }
                const sessionId = res.headers.get('mcp-session-id');
                if (sessionId) {
                    if (!sessions[server.id]) sessions[server.id] = {};
                    sessions[server.id].sessionId = sessionId;
                }
                return await parseResponse(res);
            } finally {
                clearTimeout(timer);
            }
        }

        async function initialize(server) {
            const body = {
                jsonrpc: '2.0',
                id: uid(),
                method: 'initialize',
                params: {
                    protocolVersion: '2025-03-26',
                    capabilities: {},
                    clientInfo: { name: 'mcp-console', version: '1.3.0' }
                }
            };
            const res = await request(server, body, {}, INIT_TIMEOUT_MS);
            if (res.error) throw new Error(res.error.message || 'Initialize failed');
            if (!sessions[server.id]) sessions[server.id] = {};
            sessions[server.id].protocolVersion = res.result.protocolVersion;
            sessions[server.id].serverInfo = res.result.serverInfo;
            // notifications/initialized
            const notif = { jsonrpc: '2.0', method: 'notifications/initialized' };
            try {
                await request(server, notif, {}, INIT_TIMEOUT_MS);
            } catch (e) { /* 部分服务不要求响应 */ }
            return res.result;
        }

        async function ensureSession(server) {
            if (!sessions[server.id] || !sessions[server.id].sessionId) {
                await initialize(server);
            }
        }

        async function listTools(server) {
            await ensureSession(server);
            const allTools = [];
            let cursor = undefined;
            for (let page = 0; page < MAX_TOOL_PAGES; page++) {
                const body = { jsonrpc: '2.0', id: uid(), method: 'tools/list', params: {} };
                if (cursor) body.params.cursor = cursor;
                const res = await request(server, body);
                if (res.error) throw new Error(res.error.message || 'tools/list failed');
                const tools = res.result.tools || [];
                allTools.push.apply(allTools, tools);
                cursor = res.result.nextCursor;
                if (!cursor) break;
            }
            if (!sessions[server.id]) sessions[server.id] = {};
            sessions[server.id].tools = allTools;
            sessions[server.id].toolsAt = Date.now();
            return allTools;
        }

        async function callTool(server, toolName, args) {
            await ensureSession(server);
            const body = {
                jsonrpc: '2.0',
                id: uid(),
                method: 'tools/call',
                params: { name: toolName, arguments: args || {} }
            };
            const res = await request(server, body);
            if (res.error) throw new Error(res.error.message || 'tools/call failed');
            return res.result;
        }

        function getTools(server) {
            const s = sessions[server.id];
            if (!s || !s.tools || (Date.now() - s.toolsAt) > TOOLS_CACHE_MS) return null;
            return s.tools;
        }

        function isReadOnly(tool) {
            const ann = tool.annotations || {};
            if (ann.readOnlyHint === true) return true;
            if (ann.destructiveHint === true) return false;
            const name = (tool.name || '').toLowerCase();
            for (const v of DANGER_VERBS) {
                if (name.includes(v)) return false;
            }
            return true;
        }

        function riskLevel(tool, mode) {
            if (mode === RISK_MODE.ALLOW) return 'low';
            if (isReadOnly(tool)) return 'low';
            if (mode === RISK_MODE.NEVER) return 'high';
            return 'medium';
        }

        return {
            initialize: initialize,
            listTools: listTools,
            callTool: callTool,
            getTools: getTools,
            isReadOnly: isReadOnly,
            riskLevel: riskLevel,
            sessions: sessions
        };
    })();

    /* ============================================================
     * 02-css.js — 主题、CSS、图标
     * ============================================================ */

    const IC = {
        close: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
        search: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
        add: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
        tools: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M2 8h12M2 12h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
        log: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 3h10v10H3z" stroke="currentColor" stroke-width="1.5"/><path d="M5 6h6M5 9h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
        settings: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="2.5" stroke="currentColor" stroke-width="1.5"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5L13 13M13 3l-1.5 1.5M4.5 11.5L3 13" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
        check: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 7l3.5 3.5L12 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        x: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
        chevron: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 4.5l3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        trash: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 3.5h10M5 3.5V2h4v1.5M5.5 6v4M8.5 6v4M3 3.5l.5 8h7l.5-8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        refresh: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M12 7a5 5 0 1 1-1.5-3.5M12 2v3.5H8.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    };

    function ic(name) { return IC[name] || ''; }

    function svg(s) { return s; }

    function buildCss(pal, dark) {
        const p = THEMES[pal] || THEMES[DEFAULT_PALETTE];
        const bg = dark ? '#111' : p.bg;
        const panelBg = dark ? '#1a1a1a' : p.panel;
        const text = dark ? '#eee' : p.text;
        const sub = dark ? '#999' : p.sub;
        const border = dark ? '#333' : p.border;
        const code = dark ? '#222' : p.code;
        const accent = p.accent;
        return [
            '.mcp-root *{box-sizing:border-box;margin:0;padding:0}',
            '.mcp-root{--bg:' + bg + ';--sf:' + panelBg + ';--tx:' + text + ';--sub:' + sub + ';--ln:' + border + ';--code:' + code + ';--ac:' + accent + '}',
            '.mcp-root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-size:14px;line-height:1.5;color:' + text + '}',
            '.mcp-ball{position:fixed;width:56px;height:56px;border-radius:50%;padding:0;font:inherit;outline:none;appearance:none;-webkit-appearance:none;background:' + panelBg + ';border:1px solid ' + border + ';box-shadow:0 5px 18px rgba(0,0,0,.32);display:flex;align-items:center;justify-content:center;cursor:grab;z-index:2147483000;user-select:none;touch-action:none;transition:transform .12s}',
            '.mcp-ball:active{cursor:grabbing}',
            '.mcp-ball svg{position:absolute;top:0;left:0;width:100%;height:100%;transform:rotate(-90deg);pointer-events:none}',
            '.mcp-ball .track{fill:none;stroke:' + border + ';stroke-width:2}',
            '.mcp-ball .ring{fill:none;stroke:' + accent + ';stroke-width:2.5;stroke-linecap:round;transition:stroke-dashoffset .3s ease}',
            '.mcp-ball:focus-visible{outline:2px solid ' + accent + ';outline-offset:2px}',
            '.mcp-ball .ic{position:relative;font:600 13px/1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.02em;color:' + accent + '}',
            '.mcp-ball .ic.pause{display:none}',
            '.mcp-ball.paused .ic.dsw{display:none}',
            '.mcp-ball.paused .ic.pause{display:block}',
            '.mcp-ball.paused{border-style:dashed;border-color:' + accent + '}',
            '.mcp-ball .badge{display:none;position:absolute;top:-1px;right:-1px;width:13px;height:13px;border-radius:50%;background:#dc2626;box-shadow:0 0 0 2px ' + panelBg + '}',
            '.mcp-ball.has-log .badge{display:block}',
            '.mcp-ball.holding::after{content:"";position:absolute;top:-6px;left:-6px;right:-6px;bottom:-6px;border-radius:50%;border:2px solid ' + accent + ';animation:mcpballhold .55s linear forwards}',
            '@keyframes mcpballhold{from{transform:scale(.75);opacity:.9}to{transform:scale(1);opacity:.15}}',
            '.mcp-ball.pulse{animation:mcpballpulse .45s ease}',
            '@keyframes mcpballpulse{0%{transform:scale(1)}40%{transform:scale(1.14)}100%{transform:scale(1)}}',
            '.mcp-ball.dragging{transform:scale(1.06)}',

            '.mcp-panel{position:fixed;top:0;right:0;bottom:0;width:420px;max-width:100vw;background:' + panelBg + ';z-index:2147483001;display:flex;flex-direction:column;box-shadow:-4px 0 24px rgba(0,0,0,.15);transform:translateX(100%);transition:transform .25s cubic-bezier(.4,0,.2,1)}',
            '.mcp-panel.open{transform:translateX(0)}',
            '.mcp-header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid ' + border + ';flex-shrink:0}',
            '.mcp-header h1{font-size:16px;font-weight:600}',
            '.mcp-header button{background:none;border:none;color:' + sub + ';cursor:pointer;padding:4px;border-radius:6px;display:flex}',
            '.mcp-header button:hover{background:' + code + '}',
            '.mcp-chips{display:flex;gap:4px;padding:8px 16px;border-bottom:1px solid ' + border + ';flex-shrink:0}',
            '.mcp-chip{flex:1;text-align:center;padding:7px 0;border-radius:8px;cursor:pointer;font-size:13px;color:' + sub + ';font-weight:500;transition:background .15s}',
            '.mcp-chip:hover{background:' + code + '}',
            '.mcp-chip.active{background:' + accent + ';color:#fff}',
            '.mcp-body{flex:1;overflow-y:auto;padding:12px 16px}',
            '.mcp-pane{display:none}',
            '.mcp-pane.active{display:block}',
            '.mcp-inject-bar{display:flex;gap:8px;margin-bottom:12px}',
            '.mcp-inject-bar .mcp-btn{flex:1}',
            '.mcp-guide-tip{font-size:11px;color:' + sub + ';margin-top:6px;line-height:1.6}',
            '.mcp-body::-webkit-scrollbar{width:4px}',
            '.mcp-body::-webkit-scrollbar-thumb{background:' + border + ';border-radius:2px}',
            '.mcp-server-bar{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}',
            '.mcp-server-pill{padding:5px 12px;border-radius:999px;font-size:12px;cursor:pointer;border:1px solid ' + border + ';color:' + sub + ';background:transparent;transition:all .15s}',
            '.mcp-server-pill.active{background:' + accent + ';border-color:' + accent + ';color:#fff}',
            '.mcp-server-pill.add{border-style:dashed;color:' + accent + '}',
            '.mcp-search{display:flex;align-items:center;gap:8px;padding:8px 12px;border:1px solid ' + border + ';border-radius:10px;margin-bottom:12px;color:' + sub + '}',
            '.mcp-search input{flex:1;border:none;outline:none;background:transparent;font-size:13px;color:' + text + '}',
            '.mcp-tool-card{border:1px solid ' + border + ';border-radius:12px;padding:12px 14px;margin-bottom:8px;cursor:pointer;transition:border-color .15s,box-shadow .15s}',
            '.mcp-tool-card:hover{border-color:' + accent + ';box-shadow:0 2px 8px rgba(0,0,0,.06)}',
            '.mcp-tool-card .name{font-weight:600;font-size:14px;display:flex;align-items:center;gap:6px}',
            '.mcp-tool-card .desc{font-size:12px;color:' + sub + ';margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.mcp-tool-card .meta{font-size:11px;color:' + sub + ';margin-top:6px;display:flex;gap:8px}',
            '.mcp-badge{display:inline-block;padding:1px 7px;border-radius:999px;font-size:10px;font-weight:600}',
            '.mcp-badge.ro{background:#dcfce7;color:#166534}',
            '.mcp-badge.rw{background:#fef3c7;color:#92400e}',
            '.mcp-badge.high{background:#fee2e2;color:#991b1b}',
            '.mcp-log-item{border:1px solid ' + border + ';border-radius:10px;padding:10px 12px;margin-bottom:8px}',
            '.mcp-log-item .top{display:flex;justify-content:space-between;align-items:center;font-size:12px}',
            '.mcp-log-item .tool{font-weight:600}',
            '.mcp-log-item .time{color:' + sub + ';font-size:11px}',
            '.mcp-log-item .result{font-size:12px;color:' + sub + ';margin-top:6px;white-space:pre-wrap;word-break:break-word}',
            '.mcp-empty{text-align:center;color:' + sub + ';padding:40px 0;font-size:13px}',
            '.mcp-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:8px 16px;border-radius:8px;border:none;font-size:13px;font-weight:500;cursor:pointer;transition:opacity .15s}',
            '.mcp-btn:active{opacity:.8}',
            '.mcp-btn.primary{background:' + accent + ';color:#fff}',
            '.mcp-btn.ghost{background:transparent;border:1px solid ' + border + ';color:' + text + '}',
            '.mcp-btn.danger{background:#dc2626;color:#fff}',
            '.mcp-sheet{position:absolute;top:0;left:0;right:0;bottom:0;background:' + panelBg + ';z-index:10;display:flex;flex-direction:column;transform:translateX(100%);transition:transform .2s}',
            '.mcp-sheet.open{transform:translateX(0)}',
            '.mcp-sheet-header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid ' + border + '}',
            '.mcp-sheet-header h2{font-size:15px;font-weight:600;flex:1;margin:0 8px}',
            '.mcp-sheet-body{flex:1;overflow-y:auto;padding:16px}',
            '.mcp-sheet-foot{padding:12px 16px;border-top:1px solid ' + border + ';display:flex;gap:8px;justify-content:flex-end}',
            '.mcp-field{margin-bottom:14px}',
            '.mcp-field label{display:block;font-size:12px;font-weight:500;color:' + sub + ';margin-bottom:5px}',
            '.mcp-field input,.mcp-field select,.mcp-field textarea{width:100%;padding:9px 11px;border:1px solid ' + border + ';border-radius:8px;font-size:13px;background:' + code + ';color:' + text + ';outline:none;font-family:inherit}',
            '.mcp-field input:focus,.mcp-field select:focus,.mcp-field textarea:focus{border-color:' + accent + '}',
            '.mcp-field textarea{min-height:80px;resize:vertical;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}',
            '.mcp-field .hint{font-size:11px;color:' + sub + ';margin-top:3px}',
            '.mcp-toggle{display:flex;gap:4px;background:' + code + ';border-radius:8px;padding:3px}',
            '.mcp-toggle button{flex:1;padding:6px 0;border:none;border-radius:6px;background:transparent;font-size:12px;color:' + sub + ';cursor:pointer}',
            '.mcp-toggle button.active{background:' + panelBg + ';color:' + text + ';box-shadow:0 1px 3px rgba(0,0,0,.1)}',
            '.mcp-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(20px);background:#1a1a1a;color:#fff;padding:10px 20px;border-radius:10px;font-size:13px;z-index:2147483002;opacity:0;transition:all .25s;pointer-events:none;max-width:80vw;text-align:center}',
            '.mcp-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}',
            '.mcp-toast.ok{background:#059669}',
            '.mcp-toast.err{background:#dc2626}',
            '.mcp-modal-mask{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.4);z-index:2147483003;display:flex;align-items:center;justify-content:center}',
            '.mcp-modal{background:' + panelBg + ';border-radius:14px;padding:20px;max-width:340px;width:90%;box-shadow:0 8px 40px rgba(0,0,0,.2)}',
            '.mcp-modal h3{font-size:15px;margin-bottom:8px}',
            '.mcp-modal p{font-size:13px;color:' + sub + ';margin-bottom:16px;line-height:1.5}',
            '.mcp-modal .actions{display:flex;gap:8px;justify-content:flex-end}',
            '.mcp-acc{border:1px solid ' + border + ';border-radius:10px;margin-bottom:8px;overflow:hidden}',
            '.mcp-acc-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;cursor:pointer;font-weight:500;font-size:13px;background:' + code + '}',
            '.mcp-acc-head svg{transition:transform .2s}',
            '.mcp-acc.open .mcp-acc-head svg{transform:rotate(180deg)}',
            '.mcp-acc-body{padding:0 14px;max-height:0;overflow:hidden;transition:max-height .25s,padding .25s}',
            '.mcp-acc.open .mcp-acc-body{max-height:2000px;padding:12px 14px}',
            '.mcp-pending{border:1px solid #f59e0b;background:#fffbeb;border-radius:12px;padding:12px;margin-bottom:10px}',
            '.mcp-pending .title{font-size:12px;font-weight:600;color:#92400e;margin-bottom:6px}',
            '.mcp-pending .cmd{font-family:ui-monospace,monospace;font-size:11px;background:#fef3c7;padding:6px 8px;border-radius:6px;white-space:pre-wrap;word-break:break-all;margin-bottom:8px}',
            '.mcp-pending .actions{display:flex;gap:6px}'
        ].join('\n');
    }

    /* ============================================================
     * 03-ui.js — UI 模块
     * ============================================================ */

    const UI = (function () {
        let shadow = null, host = null, root = null;
        let panel = null, ball = null, toastEl = null, mask = null, sheet = null;
        let uiCfg = Store.get(STORE_UI_CFG, { palette: DEFAULT_PALETTE, dark: false, riskMode: RISK_MODE.PARTIAL, paused: false });
        let uiState = { tab: 'tools', activeServerId: null, search: '', pendingCalls: [], unread: false, scanProgress: { done: 0, total: 0 }, accOpen: { servers: true } };
        let ballPos = Store.get(STORE_BALL, { x: window.innerWidth - 72, y: window.innerHeight - 120 });

        function applyTheme() {
            if (!shadow) return;
            const style = shadow.getElementById('mcp-theme');
            if (style) style.textContent = buildCss(uiCfg.palette, uiCfg.dark);
        }

        function showToast(msg, type) {
            if (!toastEl) return;
            toastEl.textContent = msg;
            toastEl.className = 'mcp-toast show' + (type === 'ok' ? ' ok' : type === 'err' ? ' err' : '');
            clearTimeout(toastEl._t);
            toastEl._t = setTimeout(function () { toastEl.classList.remove('show'); }, 2200);
        }

        /* ---------- 悬浮球：位置 ---------- */
        function clampBallPos() {
            const M = 6;
            const vw = window.innerWidth || 360, vh = window.innerHeight || 640;
            const w = (ball && ball.offsetWidth) || 56;
            const h = (ball && ball.offsetHeight) || 56;
            if (!ballPos || typeof ballPos.x !== 'number' || typeof ballPos.y !== 'number') {
                ballPos = { x: vw - w - 18, y: vh - h - 96 };
            }
            ballPos.x = clamp(ballPos.x, M, Math.max(M, vw - w - M));
            ballPos.y = clamp(ballPos.y, M, Math.max(M, vh - h - M));
            return ballPos;
        }

        function applyBallPosition() {
            if (!ball) return;
            clampBallPos();
            ball.style.left = ballPos.x + 'px';
            ball.style.top = ballPos.y + 'px';
        }

        /* ---------- 悬浮球：状态同步 ---------- */
        function setBallProgress(ratio) {
            if (!ball) return;
            const ring = ball.querySelector('.ring');
            if (!ring) return;
            const r = clamp(Number(ratio) || 0, 0, 1);
            ring.setAttribute('stroke-dashoffset', String(Math.round(157 * (1 - r))));
        }

        function pulseBall() {
            if (!ball) return;
            ball.classList.remove('pulse');
            void ball.offsetWidth;
            ball.classList.add('pulse');
            setTimeout(function () { if (ball) ball.classList.remove('pulse'); }, 240);
        }

        function syncBall() {
            if (!ball) return;
            ball.classList.toggle('paused', !!uiCfg.paused);
            ball.classList.toggle('has-log', !!uiState.unread);
            const p = uiState.scanProgress || { done: 0, total: 0 };
            setBallProgress(p.total ? p.done / p.total : 0);
        }

        function isPaused() { return !!uiCfg.paused; }

        function setPaused(on) {
            uiCfg.paused = !!on;
            Store.set(STORE_UI_CFG, uiCfg);
            syncBall();
            UI.showToast(uiCfg.paused ? '已暂停识别' : '已恢复识别', uiCfg.paused ? '' : 'ok');
            if (!uiCfg.paused) {
                try { Channel.scan(false); } catch (e) { }
            }
        }

        function togglePanel() {
            if (panel && panel.classList.contains('open')) closePanel();
            else openPanel();
        }

        /* ---------- 悬浮球手势 ---------- */
        function installBallDrag() {
            if (!ball) return;
            const usePointer = !!window.PointerEvent;
            const LONG_MS = 550, TAP_GAP_MS = 320, MOVE_TH = 6;
            let moved = false, aborted = false, longFired = false;
            let startX = 0, startY = 0, originX = 0, originY = 0;
            let longT = null, holdT = null, tapT = null, lastTap = 0, lastTouchAt = 0;

            function pointOf(e) {
                if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
                if (e.changedTouches && e.changedTouches[0]) return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
                return { x: e.clientX, y: e.clientY };
            }

            function clearTimers() {
                if (longT) { clearTimeout(longT); longT = null; }
                if (holdT) { clearTimeout(holdT); holdT = null; }
                if (ball) ball.classList.remove('holding');
            }

            function detach() {
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                window.removeEventListener('pointercancel', onAbort);
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
                window.removeEventListener('touchmove', onMove);
                window.removeEventListener('touchend', onUp);
                window.removeEventListener('touchcancel', onAbort);
            }

            function onMove(e) {
                const p = pointOf(e);
                const dx = p.x - startX, dy = p.y - startY;
                if (!moved && (Math.abs(dx) + Math.abs(dy) > MOVE_TH)) { moved = true; clearTimers(); }
                if (!moved) return;
                if (e.cancelable) e.preventDefault();
                ballPos.x = originX + dx;
                ballPos.y = originY + dy;
                applyBallPosition();
            }

            function onAbort() {
                clearTimers();
                detach();
                aborted = true;
                if (ball) ball.classList.remove('dragging');
            }

            function onUp(e) {
                detach();
                clearTimers();
                if (ball) ball.classList.remove('dragging');
                if (e && e.touches && e.touches.length) return;
                if (aborted) { aborted = false; return; }
                if (moved) { Store.set(STORE_BALL, ballPos); return; }
                if (longFired) return;

                const now = Date.now();
                if (now - lastTap < TAP_GAP_MS) {
                    lastTap = 0;
                    if (tapT) { clearTimeout(tapT); tapT = null; }
                    setPaused(!uiCfg.paused);
                    pulseBall();
                    return;
                }
                lastTap = now;
                if (tapT) clearTimeout(tapT);
                tapT = setTimeout(function () {
                    tapT = null;
                    lastTap = 0;
                    togglePanel();
                }, 240);
            }

            function onDown(e) {
                if (e.type === 'pointerdown' && e.isPrimary === false) return;
                if (e.type === 'mousedown' && Date.now() - lastTouchAt < 700) return;
                if (e.type === 'touchstart') lastTouchAt = Date.now();
                if (e.type === 'mousedown' && e.button != null && e.button !== 0) return;

                const p = pointOf(e);
                moved = false; aborted = false; longFired = false;
                startX = p.x; startY = p.y;
                const r = ball.getBoundingClientRect();
                originX = r.left; originY = r.top;
                ball.classList.add('dragging');
                clearTimers();

                holdT = setTimeout(function () {
                    holdT = null;
                    if (moved || longFired) return;
                    ball.classList.add('holding');
                }, 200);

                longT = setTimeout(function () {
                    longT = null;
                    if (moved || longFired) return;
                    longFired = true;
                    if (tapT) { clearTimeout(tapT); tapT = null; }
                    lastTap = 0;
                    ball.classList.remove('holding');
                    try { if (navigator.vibrate) navigator.vibrate(15); } catch (err) { }
                    pulseBall();
                    showToast('重扫工具列表');
                    scanAllServers(true);
                }, LONG_MS);

                if (usePointer) {
                    window.addEventListener('pointermove', onMove, { passive: false });
                    window.addEventListener('pointerup', onUp);
                    window.addEventListener('pointercancel', onAbort);
                } else {
                    window.addEventListener('mousemove', onMove, { passive: false });
                    window.addEventListener('mouseup', onUp);
                    window.addEventListener('touchmove', onMove, { passive: false });
                    window.addEventListener('touchend', onUp);
                    window.addEventListener('touchcancel', onAbort);
                }
            }

            ball.addEventListener('contextmenu', function (e) { e.preventDefault(); });
            if (usePointer) ball.addEventListener('pointerdown', onDown);
            else {
                ball.addEventListener('mousedown', onDown);
                ball.addEventListener('touchstart', onDown, { passive: true });
            }
        }

        /* ---------- 面板 ---------- */
        function ensurePanel() {
            if (panel) return panel;
            panel = document.createElement('div');
            panel.className = 'mcp-panel';
            panel.innerHTML =
                '<div class="mcp-header">' +
                '<h1>MCP 控制台</h1>' +
                '<button data-act="close">' + ic('close') + '</button>' +
                '</div>' +
                '<div class="mcp-chips">' +
                '<div class="mcp-chip" data-tab="tools">工具</div>' +
                '<div class="mcp-chip" data-tab="log">记录</div>' +
                '<div class="mcp-chip" data-tab="settings">设置</div>' +
                '</div>' +
                '<div class="mcp-body" id="mcp-body">' +
                '<div class="mcp-pane" data-pane="tools"></div>' +
                '<div class="mcp-pane" data-pane="log"></div>' +
                '<div class="mcp-pane" data-pane="settings"></div>' +
                '</div>';
            root.appendChild(panel);
            panel.addEventListener('click', onPanelClick);
            return panel;
        }

        function onPanelClick(e) {
            const tabEl = e.target.closest('[data-tab]');
            if (tabEl) { switchTab(tabEl.getAttribute('data-tab')); return; }
            const actEl = e.target.closest('[data-act]');
            if (actEl) { handleAction(actEl.getAttribute('data-act'), actEl); return; }
            const toolEl = e.target.closest('[data-tool]');
            if (toolEl) { openCallSheet(toolEl.getAttribute('data-tool')); return; }
            const serverEl = e.target.closest('[data-server]');
            if (serverEl) { uiState.activeServerId = serverEl.getAttribute('data-server') || null; renderTools(); return; }
        }

        function handleAction(act, el) {
            if (act === 'close') closePanel();
            else if (act === 'add-server') openServerForm();
            else if (act === 'edit-server') openServerForm(el.getAttribute('data-id'));
            else if (act === 'del-server') confirmDialog('删除服务', '确定删除此服务配置？', function () { deleteServer(el.getAttribute('data-id')); });
            else if (act === 'refresh-tools') scanAllServers(true);
            else if (act === 'clear-log') confirmDialog('清空记录', '确定清空所有调用记录？', function () { Store.set(STORE_CALLS, []); dirty.log = true; renderLog(); });
            else if (act === 'toggle-dark') { uiCfg.dark = !uiCfg.dark; Store.set(STORE_UI_CFG, uiCfg); applyTheme(); renderSettings(); }
            else if (act === 'set-palette') { uiCfg.palette = el.getAttribute('data-pal'); Store.set(STORE_UI_CFG, uiCfg); applyTheme(); renderSettings(); }
            else if (act === 'set-risk') { uiCfg.riskMode = el.getAttribute('data-mode'); Store.set(STORE_UI_CFG, uiCfg); renderSettings(); }
            else if (act === 'confirm-call') doCall(el.getAttribute('data-call'));
            else if (act === 'reject-call') rejectCall(el.getAttribute('data-call'));
            else if (act === 'ai-guide-attach') AI.attachGuide();
            else if (act === 'ai-guide-copy') AI.copyGuide();
            else if (act === 'ai-prompt-inject') AI.injectPrompt(true);
            else if (act === 'ai-prompt-fill') AI.injectPrompt(false);
            else if (act === 'ai-reset-session') { resetForNewConversation(); toast('已重置会话状态', 'ok'); }
            else if (act === 'ai-rescan') scanAllServers(true);
        }

        const dirty = { tools: true, log: true, settings: true };

        function markDirty(name) {
            if (!name) { dirty.tools = true; dirty.log = true; dirty.settings = true; return; }
            dirty[name] = true;
        }

        function pane(name) {
            if (!panel) return null;
            return panel.querySelector('.mcp-pane[data-pane="' + name + '"]');
        }

        function switchTab(tab) {
            uiState.tab = tab;
            if (tab === 'tools') uiState.unread = false;
            syncBall();
            if (panel) {
                panel.querySelectorAll('.mcp-chip').forEach(function (c) {
                    c.classList.toggle('active', c.getAttribute('data-tab') === tab);
                });
                panel.querySelectorAll('.mcp-pane').forEach(function (p) {
                    p.classList.toggle('active', p.getAttribute('data-pane') === tab);
                });
            }
            if (dirty[tab]) renderActive();
        }

        function renderActive() {
            if (uiState.tab === 'tools') renderTools();
            else if (uiState.tab === 'log') renderLog();
            else if (uiState.tab === 'settings') renderSettings();
        }

        /* ---------- 新对话状态重置 ---------- */
        function resetForNewConversation() {
            uiState.pendingCalls = [];
            uiState.search = '';
            uiState.activeServerId = null;
            uiState.unread = false;
            uiState.accOpen = { servers: true };
            markDirty();
            syncBall();
            if (panel && panel.classList.contains('open')) renderActive();
            try { AI.clearInjection(); } catch (e) { }
        }

        function refresh(force) {
            syncBall();
            if (!panel || !panel.classList.contains('open')) return;
            if (force) markDirty();
            if (dirty[uiState.tab]) renderActive();
        }

        function getServers() { return Store.get(STORE_SERVERS, []); }
        function getCalls() { return Store.get(STORE_CALLS, []); }

        /* ---------- 工具页 ---------- */
        function renderTools() {
            const body = pane('tools');
            if (!body) return;
            const prevFocus = document.activeElement;
            const restoreSearch = !!(prevFocus && prevFocus.closest && prevFocus.closest('.mcp-search'));
            const caret = restoreSearch ? prevFocus.selectionStart : null;
            const servers = getServers();
            let bar = '<div class="mcp-server-bar">';
            bar += '<div class="mcp-server-pill ' + (!uiState.activeServerId ? 'active' : '') + '" data-server="">全部</div>';
            for (const s of servers) {
                bar += '<div class="mcp-server-pill ' + (uiState.activeServerId === s.id ? 'active' : '') + '" data-server="' + esc(s.id) + '">' + esc(s.name || s.url) + '</div>';
            }
            bar += '<div class="mcp-server-pill add" data-act="add-server">' + ic('add') + ' 添加</div>';
            bar += '</div>';

            bar += '<div class="mcp-search">' + ic('search') + '<input placeholder="搜索工具..." value="' + esc(uiState.search) + '"></div>';

            let tools = [];
            for (const s of servers) {
                if (uiState.activeServerId && s.id !== uiState.activeServerId) continue;
                const list = Mcp.getTools(s);
                if (list) {
                    for (const t of list) tools.push({ server: s, tool: t });
                }
            }
            if (uiState.search) {
                const q = uiState.search.toLowerCase();
                tools = tools.filter(function (x) {
                    return (x.tool.name || '').toLowerCase().includes(q) || (x.tool.description || '').toLowerCase().includes(q);
                });
            }

            let html = bar;
            if (uiState.pendingCalls.length) {
                for (const pc of uiState.pendingCalls) {
                    html += '<div class="mcp-pending">' +
                        '<div class="title">AI 请求调用</div>' +
                        '<div class="cmd">' + esc(pc.raw) + '</div>' +
                        '<div class="actions">' +
                        '<button class="mcp-btn primary" data-act="confirm-call" data-call="' + esc(pc.id) + '">确认执行</button>' +
                        '<button class="mcp-btn ghost" data-act="reject-call" data-call="' + esc(pc.id) + '">忽略</button>' +
                        '</div></div>';
                }
            }

            if (!tools.length) {
                html += '<div class="mcp-empty">' + (servers.length ? '暂无工具，请点击刷新' : '请先添加 MCP 服务') + '</div>';
            } else {
                for (const x of tools) {
                    const t = x.tool, s = x.server;
                    const ro = Mcp.isReadOnly(t);
                    html += '<div class="mcp-tool-card" data-tool="' + esc(s.id + '::' + t.name) + '">' +
                        '<div class="name">' + esc(t.name) +
                        '<span class="mcp-badge ' + (ro ? 'ro' : 'rw') + '">' + (ro ? '只读' : '写入') + '</span></div>' +
                        (t.description ? '<div class="desc">' + esc(t.description) + '</div>' : '') +
                        '<div class="meta"><span>' + esc(s.name || s.url) + '</span></div>' +
                        '</div>';
                }
            }
            body.innerHTML = html;

            const input = body.querySelector('.mcp-search input');
            if (input) {
                input.addEventListener('input', function () {
                    uiState.search = input.value;
                    renderTools();
                });
                if (restoreSearch) {
                    input.focus();
                    try { input.setSelectionRange(caret, caret); } catch (e) { }
                }
            }
            dirty.tools = false;
        }

        /* ---------- 调用 sheet ---------- */
        function openCallSheet(key) {
            const parts = key.split('::');
            const serverId = parts[0], toolName = parts[1];
            const servers = getServers();
            const server = servers.find(function (s) { return s.id === serverId; });
            if (!server) return;
            const tools = Mcp.getTools(server) || [];
            const tool = tools.find(function (t) { return t.name === toolName; });
            if (!tool) { toast('工具不存在', 'err'); return; }

            if (sheet) sheet.remove();
            sheet = document.createElement('div');
            sheet.className = 'mcp-sheet';
            const schema = tool.inputSchema || {};
            const props = schema.properties || {};
            const required = schema.required || [];

            let formHtml = '<div class="mcp-toggle" id="mcp-mode-toggle">' +
                '<button data-mode="form" class="active">表单</button>' +
                '<button data-mode="json">JSON</button></div>';

            formHtml += '<div id="mcp-form-area">';
            for (const key in props) {
                if (!props.hasOwnProperty(key)) continue;
                const p = props[key];
                const isReq = required.indexOf(key) >= 0;
                formHtml += '<div class="mcp-field" data-field="' + esc(key) + '">';
                formHtml += '<label>' + esc(key) + (isReq ? ' *' : '') + '</label>';
                if (p.enum) {
                    formHtml += '<select data-key="' + esc(key) + '">';
                    for (const v of p.enum) formHtml += '<option value="' + esc(v) + '">' + esc(v) + '</option>';
                    formHtml += '</select>';
                } else if (p.type === 'boolean') {
                    formHtml += '<select data-key="' + esc(key) + '"><option value="true">true</option><option value="false">false</option></select>';
                } else if (p.type === 'number' || p.type === 'integer') {
                    formHtml += '<input type="number" data-key="' + esc(key) + '" placeholder="' + esc(p.description || '') + '">';
                } else if (p.type === 'object' || p.type === 'array') {
                    formHtml += '<textarea data-key="' + esc(key) + '" placeholder=\'' + esc(JSON.stringify(p.example || {})) + '\'></textarea>';
                } else {
                    formHtml += '<input type="text" data-key="' + esc(key) + '" placeholder="' + esc(p.description || '') + '">';
                }
                if (p.description) formHtml += '<div class="hint">' + esc(p.description) + '</div>';
                formHtml += '</div>';
            }
            formHtml += '</div>';

            formHtml += '<div id="mcp-json-area" style="display:none">' +
                '<div class="mcp-field"><textarea id="mcp-json-input" style="min-height:160px" placeholder=\'{"key":"value"}\'></textarea></div>' +
                '</div>';

            sheet.innerHTML =
                '<div class="mcp-sheet-header">' +
                '<button data-act="close-sheet" style="background:none;border:none;color:inherit;cursor:pointer;padding:4px">' + ic('close') + '</button>' +
                '<h2>' + esc(tool.name) + '</h2>' +
                '<span></span>' +
                '</div>' +
                '<div class="mcp-sheet-body">' +
                formHtml +
                '</div>' +
                '<div class="mcp-sheet-foot">' +
                '<button class="mcp-btn ghost" data-act="close-sheet">取消</button>' +
                '<button class="mcp-btn primary" data-act="do-call" data-server="' + esc(server.id) + '" data-tool="' + esc(tool.name) + '">调用</button>' +
                '</div>';

            panel.appendChild(sheet);
            requestAnimationFrame(function () { sheet.classList.add('open'); });

            sheet.addEventListener('click', function (e) {
                const act = e.target.closest('[data-act]');
                if (act) {
                    const a = act.getAttribute('data-act');
                    if (a === 'close-sheet') { closeSheet(); return; }
                    if (a === 'do-call') {
                        const mode = sheet.querySelector('#mcp-mode-toggle .active').getAttribute('data-mode');
                        let args = {};
                        if (mode === 'json') {
                            const raw = sheet.querySelector('#mcp-json-input').value.trim();
                            if (raw) {
                                const parsed = safeJson(raw);
                                if (parsed === null) { toast('JSON 格式错误', 'err'); return; }
                                args = parsed;
                            }
                        } else {
                            sheet.querySelectorAll('[data-key]').forEach(function (inp) {
                                const k = inp.getAttribute('data-key');
                                let v = inp.value;
                                if (inp.type === 'number') v = v === '' ? undefined : Number(v);
                                else if (inp.tagName === 'SELECT' && (v === 'true' || v === 'false')) v = v === 'true';
                                else if (inp.tagName === 'TEXTAREA' && v.trim()) {
                                    const parsed = safeJson(v);
                                    if (parsed !== null) v = parsed;
                                }
                                if (v !== undefined && v !== '') args[k] = v;
                            });
                        }
                        executeCall(act.getAttribute('data-server'), act.getAttribute('data-tool'), args);
                        closeSheet();
                    }
                }
                const toggle = e.target.closest('#mcp-mode-toggle button');
                if (toggle) {
                    sheet.querySelectorAll('#mcp-mode-toggle button').forEach(function (b) { b.classList.remove('active'); });
                    toggle.classList.add('active');
                    const mode = toggle.getAttribute('data-mode');
                    sheet.querySelector('#mcp-form-area').style.display = mode === 'form' ? 'block' : 'none';
                    sheet.querySelector('#mcp-json-area').style.display = mode === 'json' ? 'block' : 'none';
                }
            });
        }

        function closeSheet() {
            if (sheet) {
                sheet.classList.remove('open');
                setTimeout(function () { if (sheet) { sheet.remove(); sheet = null; } }, 220);
            }
        }

        /* ---------- 调用执行 ---------- */
        async function executeCall(serverId, toolName, args) {
            const servers = getServers();
            const server = servers.find(function (s) { return s.id === serverId; });
            if (!server) { toast('服务不存在', 'err'); return; }
            const tools = Mcp.getTools(server) || [];
            const tool = tools.find(function (t) { return t.name === toolName; });
            const risk = tool ? Mcp.riskLevel(tool, uiCfg.riskMode) : 'low';

            const doIt = async function () {
                toast('调用中...');
                const start = Date.now();
                try {
                    const result = await Mcp.callTool(server, toolName, args);
                    const duration = Date.now() - start;
                    addCallRecord({ serverId: server.id, serverName: server.name || server.url, tool: toolName, args: args, ok: true, duration: duration, result: result });
                    toast('调用成功', 'ok');
                    renderResult(result);
                    refresh();
                } catch (e) {
                    const duration = Date.now() - start;
                    addCallRecord({ serverId: server.id, serverName: server.name || server.url, tool: toolName, args: args, ok: false, duration: duration, error: e.message || String(e) });
                    toast('调用失败: ' + (e.message || e), 'err');
                    refresh();
                }
            };

            if (risk === 'high') {
                confirmDialog('高风险调用', '工具「' + toolName + '」可能执行写入或危险操作，确定继续？', doIt);
            } else if (risk === 'medium') {
                confirmDialog('确认调用', '即将调用「' + toolName + '」，是否继续？', doIt);
            } else {
                doIt();
            }
        }

        function addCallRecord(rec) {
            const list = getCalls();
            rec.at = Date.now();
            list.unshift(rec);
            if (list.length > CALL_HISTORY_MAX) list.length = CALL_HISTORY_MAX;
            Store.set(STORE_CALLS, list);
            dirty.log = true;
        }

        function renderResult(result) {
            // 在面板内以 sheet 形式展示结果
            if (sheet) sheet.remove();
            sheet = document.createElement('div');
            sheet.className = 'mcp-sheet open';
            let html = '<div class="mcp-sheet-header"><h2>调用结果</h2><button data-act="close-sheet" style="background:none;border:none;color:inherit;cursor:pointer;padding:4px">' + ic('close') + '</button></div><div class="mcp-sheet-body">';
            if (result && result.content) {
                for (const c of result.content) {
                    if (c.type === 'text') {
                        html += '<pre style="white-space:pre-wrap;word-break:break-word;font-size:12px;background:var(--code);color:var(--tx);padding:12px;border-radius:8px;margin-bottom:8px">' + esc(c.text) + '</pre>';
                    } else if (c.type === 'image' && c.data) {
                        html += '<img src="data:' + esc(c.mimeType || 'image/png') + ';base64,' + c.data + '" style="max-width:100%;border-radius:8px;margin-bottom:8px">';
                    } else {
                        html += '<pre style="white-space:pre-wrap;word-break:break-word;font-size:12px;background:var(--code);padding:12px;border-radius:8px;margin-bottom:8px">' + esc(JSON.stringify(c, null, 2)) + '</pre>';
                    }
                }
            } else {
                html += '<pre style="white-space:pre-wrap;word-break:break-word;font-size:12px">' + esc(JSON.stringify(result, null, 2)) + '</pre>';
            }
            html += '</div>';
            sheet.innerHTML = html;
            panel.appendChild(sheet);
            sheet.addEventListener('click', function (e) {
                if (e.target.closest('[data-act="close-sheet"]')) closeSheet();
            });
        }

        /* ---------- 记录页 ---------- */
        function renderLog() {
            const body = pane('log');
            if (!body) return;
            const list = getCalls();
            let html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
                '<span style="font-size:12px;color:var(--sub)">最近 ' + list.length + ' 条</span>' +
                '<button class="mcp-btn ghost" style="padding:4px 10px;font-size:12px" data-act="clear-log">' + ic('trash') + ' 清空</button>' +
                '</div>';
            if (!list.length) { html += '<div class="mcp-empty">暂无调用记录</div>'; }
            else {
                for (const c of list) {
                    let resultText = '';
                    if (c.ok) {
                        try { resultText = summarizeResult(c.result); } catch (e) { resultText = '(无法预览)'; }
                    } else {
                        resultText = c.error || '未知错误';
                    }
                    html += '<div class="mcp-log-item">' +
                        '<div class="top"><span class="tool">' + esc(c.tool) + '</span><span class="time">' + fmtClock(c.at) + ' · ' + fmtDuration(c.duration || 0) + '</span></div>' +
                        '<div class="result">' + esc(resultText.slice(0, 200)) + (resultText.length > 200 ? '…' : '') + '</div>' +
                        '</div>';
                }
            }
            body.innerHTML = html;
            dirty.log = false;
        }

        function summarizeResult(result) {
            if (!result) return '';
            if (result.content && result.content.length) {
                const textParts = result.content.filter(function (c) { return c.type === 'text'; }).map(function (c) { return c.text; });
                if (textParts.length) return textParts.join('\n');
            }
            return JSON.stringify(result).slice(0, 400);
        }

        /* ---------- 设置页 ---------- */
        function renderSettings() {
            const body = pane('settings');
            if (!body) return;
            const servers = getServers();
            const accOpen = uiState.accOpen || (uiState.accOpen = { servers: true });

            let html = '<div class="mcp-acc' + (accOpen.servers ? ' open' : '') + '" data-acc="servers">' +
                '<div class="mcp-acc-head">服务管理 ' + ic('chevron') + '</div>' +
                '<div class="mcp-acc-body">';
            if (!servers.length) html += '<div class="mcp-empty" style="padding:16px">还没有服务</div>';
            for (const s of servers) {
                html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">' +
                    '<div style="min-width:0"><div style="font-weight:500;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(s.name || s.url) + '</div>' +
                    '<div style="font-size:11px;color:var(--sub);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(s.url) + '</div></div>' +
                    '<div style="display:flex;gap:4px;flex-shrink:0">' +
                    '<button class="mcp-btn ghost" style="padding:4px 8px;font-size:11px" data-act="edit-server" data-id="' + esc(s.id) + '">编辑</button>' +
                    '<button class="mcp-btn ghost" style="padding:4px 8px;font-size:11px" data-act="del-server" data-id="' + esc(s.id) + '">' + ic('trash') + '</button>' +
                    '</div></div>';
            }
            html += '<div style="margin-top:12px"><button class="mcp-btn primary" style="width:100%" data-act="add-server">' + ic('add') + ' 添加服务</button></div>';
            html += '</div></div>';

            // 外观
            html += '<div class="mcp-acc' + (accOpen.appearance ? ' open' : '') + '" data-acc="appearance">' +
                '<div class="mcp-acc-head">外观 ' + ic('chevron') + '</div>' +
                '<div class="mcp-acc-body">' +
                '<div class="mcp-field"><label>配色</label><div style="display:flex;gap:6px;flex-wrap:wrap">';
            for (const k of THEME_KEYS) {
                html += '<button class="mcp-server-pill ' + (uiCfg.palette === k ? 'active' : '') + '" data-act="set-palette" data-pal="' + k + '">' + THEMES[k].name + '</button>';
            }
            html += '</div></div>' +
                '<div class="mcp-field"><label>深色模式</label><button class="mcp-btn ghost" data-act="toggle-dark">' + (uiCfg.dark ? '当前：深色' : '当前：浅色') + '</button></div>' +
                '</div></div>';

            // 风险控制
            html += '<div class="mcp-acc' + (accOpen.risk ? ' open' : '') + '" data-acc="risk">' +
                '<div class="mcp-acc-head">风险控制 ' + ic('chevron') + '</div>' +
                '<div class="mcp-acc-body">' +
                '<div class="mcp-field"><label>模式</label><div style="display:flex;gap:6px">';
            const modes = [[RISK_MODE.ALLOW, '全部允许'], [RISK_MODE.PARTIAL, '部分确认'], [RISK_MODE.NEVER, '全部确认']];
            for (const m of modes) {
                html += '<button class="mcp-server-pill ' + (uiCfg.riskMode === m[0] ? 'active' : '') + '" data-act="set-risk" data-mode="' + m[0] + '">' + m[1] + '</button>';
            }
            html += '</div><div class="hint">全部允许：直接调用；部分确认：只读工具直接调用，写入工具确认；全部确认：任何工具都确认</div></div>' +
                '</div></div>';

            // AI 通道
            html += '<div class="mcp-acc' + (accOpen.ai ? ' open' : '') + '" data-acc="ai">' +
                '<div class="mcp-acc-head">AI 通道 ' + ic('chevron') + '</div>' +
                '<div class="mcp-acc-body">' +
                '<div class="mcp-field"><label>工具调用说明</label>' +
                '<div class="mcp-inject-bar">' +
                '<button class="mcp-btn primary" data-act="ai-guide-attach">生成说明附件</button>' +
                '<button class="mcp-btn ghost" data-act="ai-guide-copy">复制说明文本</button>' +
                '</div>' +
                '<div class="mcp-guide-tip">附件内容为当前已扫描到的全部 MCP 服务与工具，按服务分节，可直接发给 AI 阅读。</div></div>' +
                '<div class="mcp-field"><label>系统提示词</label>' +
                '<div class="mcp-inject-bar">' +
                '<button class="mcp-btn primary" data-act="ai-prompt-inject">注入并发送</button>' +
                '<button class="mcp-btn ghost" data-act="ai-prompt-fill">仅填入输入框</button>' +
                '</div>' +
                '<div class="mcp-guide-tip">提示词会与当前输入框内容合并后发送，不会单独占一条消息。</div></div>' +
                '<div class="mcp-field"><label>会话</label>' +
                '<div class="mcp-inject-bar">' +
                '<button class="mcp-btn ghost" data-act="ai-reset-session">重置当前会话状态</button>' +
                '<button class="mcp-btn ghost" data-act="ai-rescan">重扫工具</button>' +
                '</div></div>' +
                '</div></div>';

            // 关于
            html += '<div class="mcp-acc' + (accOpen.about ? ' open' : '') + '" data-acc="about">' +
                '<div class="mcp-acc-head">关于 ' + ic('chevron') + '</div>' +
                '<div class="mcp-acc-body">' +
                '<div style="font-size:12px;color:var(--sub);line-height:1.8">' +
                'MCP 控制台 v1.3.0<br>支持 Streamable HTTP (含 SSE)<br>协议版本 2025-03-26<br>仅 DeepSeek 平台<br>数据存储在本地 GM 存储' +
                '</div></div></div>';

            body.innerHTML = html;
            dirty.settings = false;

            // 手风琴
            body.querySelectorAll('.mcp-acc-head').forEach(function (head) {
                head.addEventListener('click', function () {
                    const acc = head.parentElement;
                    acc.classList.toggle('open');
                    const name = acc.getAttribute('data-acc');
                    if (name) { uiState.accOpen = uiState.accOpen || {}; uiState.accOpen[name] = acc.classList.contains('open'); }
                });
            });
        }

        /* ---------- 服务表单 ---------- */
        function openServerForm(id) {
            const servers = getServers();
            const existing = id ? servers.find(function (s) { return s.id === id; }) : null;

            if (mask) mask.remove();
            mask = document.createElement('div');
            mask.className = 'mcp-modal-mask';
            let headersText = '';
            if (existing && existing.headers) {
                headersText = Object.keys(existing.headers).map(function (k) { return k + ': ' + existing.headers[k]; }).join('\n');
            }
            mask.innerHTML = '<div class="mcp-modal" style="max-width:400px">' +
                '<h3>' + (existing ? '编辑服务' : '添加服务') + '</h3>' +
                '<div class="mcp-field"><label>名称</label><input id="mcp-sf-name" value="' + esc(existing ? existing.name : '') + '" placeholder="我的 MCP 服务"></div>' +
                '<div class="mcp-field"><label>URL</label><input id="mcp-sf-url" value="' + esc(existing ? existing.url : '') + '" placeholder="https://example.com/mcp"></div>' +
                '<div class="mcp-field"><label>Headers（每行 Key: Value）</label><textarea id="mcp-sf-headers" placeholder="Authorization: Bearer xxx">' + esc(headersText) + '</textarea></div>' +
                '<div class="actions">' +
                '<button class="mcp-btn ghost" data-act="cancel">取消</button>' +
                '<button class="mcp-btn primary" data-act="save">保存</button>' +
                '</div></div>';
            root.appendChild(mask);

            mask.addEventListener('click', function (e) {
                if (e.target === mask) { mask.remove(); mask = null; return; }
                const act = e.target.closest('[data-act]');
                if (!act) return;
                if (act.getAttribute('data-act') === 'cancel') { mask.remove(); mask = null; return; }
                if (act.getAttribute('data-act') === 'save') {
                    const name = mask.querySelector('#mcp-sf-name').value.trim();
                    const url = mask.querySelector('#mcp-sf-url').value.trim();
                    if (!url) { toast('URL 不能为空', 'err'); return; }
                    const headers = {};
                    const hRaw = mask.querySelector('#mcp-sf-headers').value.trim();
                    if (hRaw) {
                        hRaw.split('\n').forEach(function (line) {
                            const idx = line.indexOf(':');
                            if (idx > 0) {
                                const k = line.slice(0, idx).trim();
                                const v = line.slice(idx + 1).trim();
                                if (k) headers[k] = v;
                            }
                        });
                    }
                    const list = getServers();
                    if (existing) {
                        existing.name = name || url;
                        existing.url = url;
                        existing.headers = headers;
                    } else {
                        list.push({ id: uid(), name: name || url, url: url, headers: headers });
                    }
                    Store.set(STORE_SERVERS, list);
                    mask.remove(); mask = null;
                    toast('服务已保存', 'ok');
                    scanAllServers();
                    renderSettings();
                }
            });
        }

        function deleteServer(id) {
            const list = getServers().filter(function (s) { return s.id !== id; });
            Store.set(STORE_SERVERS, list);
            if (uiState.activeServerId === id) uiState.activeServerId = null;
            toast('已删除', 'ok');
            renderSettings();
            refresh();
        }

        /* ---------- 确认框 ---------- */
        function confirmDialog(title, msg, cb) {
            if (mask) mask.remove();
            mask = document.createElement('div');
            mask.className = 'mcp-modal-mask';
            mask.innerHTML = '<div class="mcp-modal">' +
                '<h3>' + esc(title) + '</h3>' +
                '<p>' + esc(msg) + '</p>' +
                '<div class="actions">' +
                '<button class="mcp-btn ghost" data-act="no">取消</button>' +
                '<button class="mcp-btn danger" data-act="yes">确定</button>' +
                '</div></div>';
            root.appendChild(mask);
            mask.addEventListener('click', function (e) {
                const act = e.target.closest('[data-act]');
                if (!act) return;
                if (act.getAttribute('data-act') === 'no') { mask.remove(); mask = null; return; }
                if (act.getAttribute('data-act') === 'yes') { mask.remove(); mask = null; if (cb) cb(); }
            });
        }

        /* ---------- 待确认调用 ---------- */
        function setPendingCalls(list) {
            uiState.pendingCalls = list;
            uiState.unread = !!(list && list.length);
            syncBall();
            dirty.tools = true;
            if (panel && panel.classList.contains('open') && uiState.tab === 'tools') renderTools();
        }

        function getPendingCalls() { return uiState.pendingCalls; }

        function doCall(id) {
            const pc = uiState.pendingCalls.find(function (x) { return x.id === id; });
            if (!pc) return;
            executeCall(pc.serverId, pc.toolName, pc.args);
            uiState.pendingCalls = uiState.pendingCalls.filter(function (x) { return x.id !== id; });
            refresh();
        }

        function rejectCall(id) {
            uiState.pendingCalls = uiState.pendingCalls.filter(function (x) { return x.id !== id; });
            refresh();
        }


        /* ---------- 全量扫描 ---------- */
        async function scanAllServers(force) {
            const servers = getServers();
            uiState.scanProgress = { done: 0, total: servers.length };
            syncBall();
            if (!servers.length) return;
            for (const s of servers) {
                if (!force && Mcp.getTools(s)) {
                    uiState.scanProgress.done++;
                    syncBall();
                    continue;
                }
                try {
                    await Mcp.listTools(s);
                } catch (e) {
                    warn('listTools failed for ' + s.name, e.message);
                }
                uiState.scanProgress.done++;
                syncBall();
            }
            uiState.scanProgress = { done: 0, total: 0 };
            syncBall();
            dirty.tools = true;
            if (uiState.tab === 'tools') renderTools();
        }

        /* ---------- 挂载 ---------- */
        function mount() {
            host = document.createElement('div');
            host.className = 'mcp-root';
            shadow = host.attachShadow({ mode: 'open' });

            const style = document.createElement('style');
            style.id = 'mcp-theme';
            style.textContent = buildCss(uiCfg.palette, uiCfg.dark);
            shadow.appendChild(style);

            root = document.createElement('div');
            root.className = 'mcp-root';
            shadow.appendChild(root);

            // 悬浮球
            ball = document.createElement('button');
            ball.type = 'button';
            ball.className = 'mcp-ball';
            ball.setAttribute('aria-label', '打开 MCP 控制台');
            ball.innerHTML =
                '<svg viewBox="0 0 56 56" aria-hidden="true">' +
                '<circle class="track" cx="28" cy="28" r="25"/>' +
                '<circle class="ring" cx="28" cy="28" r="25" stroke-dasharray="157" stroke-dashoffset="157"/>' +
                '</svg>' +
                '<span class="ic dsw">MCP</span>' +
                '<span class="ic pause">❙❙</span>' +
                '<span class="badge"></span>';
            root.appendChild(ball);
            applyBallPosition();
            window.addEventListener('resize', applyBallPosition);
            installBallDrag();
            syncBall();

            // Toast
            toastEl = document.createElement('div');
            toastEl.className = 'mcp-toast';
            root.appendChild(toastEl);

            // 面板
            ensurePanel();

            // 初始 tab
            switchTab('tools');

            document.body.appendChild(host);
        }

        function openPanel() {
            ensurePanel();
            panel.classList.add('open');
            uiState.unread = false;
            syncBall();
            switchTab(uiState.tab);
        }

        function closePanel() {
            if (panel) panel.classList.remove('open');
        }

        return {
            mount: mount,
            openPanel: openPanel,
            closePanel: closePanel,
            refresh: refresh,
            showToast: showToast,
            setPendingCalls: setPendingCalls,
            getPendingCalls: getPendingCalls,
            scanAllServers: scanAllServers,
            isPaused: isPaused,
            resetForNewConversation: resetForNewConversation
        };
    })();

    /* ============================================================
     * 04-channel.js — AI 通道（```mcp 块扫描）
     * ============================================================ */

    const Channel = (function () {
        let observer = null;
        let scanning = false;
        let seen = new Set();

        function detectLang(codeEl) {
            const cls = (codeEl.className || '') + ' ' +
                        ((codeEl.parentElement && codeEl.parentElement.className) || '');
            const m = cls.match(/language-([\w-]+)/i);
            if (m) return m[1].toLowerCase();
            let box = codeEl.closest('pre');
            box = box ? box.parentElement : null;
            for (let i = 0; i < 3 && box; i++, box = box.parentElement) {
                const label = box.querySelector('[class*="banner"],[class*="header"],[class*="lang"],[class*="title"]');
                if (label) {
                    const t = (label.textContent || '').trim().toLowerCase();
                    if (t && t.length < 20) return t;
                }
            }
            const first = (codeEl.textContent || '').trim().split('\n')[0].trim();
            if (first.startsWith('```')) return first.replace(/`/g, '').trim().toLowerCase();
            return '';
        }

        function scan(force) {
            if (scanning) return;
            if (UI.isPaused && UI.isPaused()) return;
            scanning = true;
            try {
                const messages = document.querySelectorAll(
                    '[data-message-author-role="assistant"], .ds-markdown, [class*="message"]');
                for (const msg of messages) {
                    const id = msg.getAttribute('data-message-id') ||
                               msg.getAttribute('data-testid') || '';
                    if (!force && id && seen.has(id)) continue;
                    if (id) seen.add(id);
                    const blocks = msg.querySelectorAll('pre code');
                    for (const block of blocks) {
                        const text = block.textContent || '';
                        const lang = detectLang(block);
                        if (lang === 'mcp' || /^\s*```mcp/.test(text)) {
                            parseBlock(text, id);
                        }
                    }
                }
            } finally {
                scanning = false;
            }
        }

        function parseBlock(text, msgId) {
            let raw = text;
            const match = text.match(/```mcp\s*\n([\s\S]*?)(?:```|$)/);
            if (match) raw = match[1];
            raw = raw.trim();
            if (!raw) return;
            const lines = raw.split('\n').filter(function (l) { return l.trim() && !l.trim().startsWith('#'); });
            if (!lines.length) return;

            // 第一行格式：serverName toolName 或 toolName
            const first = lines[0].trim();
            const parts = first.split(/\s+/);
            let serverName = null, toolName = null;
            if (parts.length >= 2) { serverName = parts[0]; toolName = parts[1]; }
            else toolName = parts[0];

            let args = {};
            const rest = lines.slice(1).join('\n').trim();
            if (rest) {
                const parsed = safeJson(rest);
                if (parsed && typeof parsed === 'object') args = parsed;
            }

            const servers = Store.get(STORE_SERVERS, []);
            let server = null;
            if (serverName) {
                server = servers.find(function (s) { return (s.name || s.url) === serverName; });
            }
            if (!server && servers.length === 1) server = servers[0];
            if (!server) {
                // 在所有服务里找工具
                for (const s of servers) {
                    const tools = Mcp.getTools(s);
                    if (tools && tools.some(function (t) { return t.name === toolName; })) { server = s; break; }
                }
            }
            if (!server) return;

            const pc = {
                id: uid(),
                serverId: server.id,
                serverName: server.name || server.url,
                toolName: toolName,
                args: args,
                raw: raw.slice(0, 500),
                msgId: msgId,
                at: Date.now()
            };

            const pending = UI.getPendingCalls();
            if (pending.some(function (p) { return p.msgId === msgId && p.toolName === toolName; })) return;
            pending.push(pc);
            UI.setPendingCalls(pending);
            UI.showToast('AI 请求调用：' + toolName, 'ok');
        }

        function init() {
            scan(true);
            observer = new MutationObserver(function () { scan(false); });
            observer.observe(document.body, { childList: true, subtree: true });
        }

        return { init: init, scan: scan };
    })();

    /* ============================================================
     * 06-ai.js — 工具说明生成 / 附件交付 / 系统提示词注入 / 会话识别
     * ============================================================ */

    const AI = (function () {
        const SEP = '\n\n---\n\n';
        const PROMPT_FILE = 'MCP-工具调用说明.md';
        let lastKey = null;
        let sawMessages = false;
        let injectedKeys = {};

        /* ---------- 指南生成 ---------- */
        function fence() { return '\u0060\u0060\u0060'; }

        function schemaSkeleton(schema) {
            const out = {};
            const props = (schema && schema.properties) || {};
            for (const k in props) {
                if (!props.hasOwnProperty(k)) continue;
                const p = props[k] || {};
                if (p.enum && p.enum.length) out[k] = p.enum[0];
                else if (p.type === 'number' || p.type === 'integer') out[k] = 0;
                else if (p.type === 'boolean') out[k] = false;
                else if (p.type === 'array') out[k] = [];
                else if (p.type === 'object') out[k] = {};
                else out[k] = '';
            }
            return out;
        }

        function paramLines(schema) {
            const props = (schema && schema.properties) || {};
            const req = (schema && schema.required) || [];
            const keys = Object.keys(props);
            if (!keys.length) return ['- 无参数'];
            return keys.map(function (k) {
                const p = props[k] || {};
                const bits = [p.type || 'any'];
                if (req.indexOf(k) >= 0) bits.push('必填');
                if (p.enum) bits.push('可选值：' + p.enum.join(' / '));
                return '- `' + k + '`（' + bits.join('，') + '）' + (p.description ? ' — ' + p.description : '');
            });
        }

        function buildGuide() {
            const servers = Store.get(STORE_SERVERS, []);
            const F = fence();
            const L = [];
            L.push('# MCP 工具调用说明');
            L.push('');
            L.push('本文件由 MCP 控制台自动生成，列出当前可用的全部 MCP 服务与工具。');
            L.push('');
            L.push('## 调用方式');
            L.push('');
            L.push('在回复中写一个 ' + F + 'mcp 代码块。**第一行写「服务名 工具名」**，从第二行起写 JSON 参数。');
            L.push('');
            L.push(F + 'mcp');
            L.push('<服务名> <工具名>');
            L.push('{ "参数": "值" }');
            L.push(F);
            L.push('');
            L.push('## 重要规则');
            L.push('');
            L.push('1. **第一行必须写服务名**，即使只有一个服务也要写，避免同名工具被派到错误的服务。');
            L.push('2. 服务名与工具名必须**逐字照抄**，不要翻译、不要改大小写、不要加空格。');
            L.push('3. 不同服务下可能存在**同名工具**，它们属于不同服务，参数与行为都可能不同，不能互相替代。');
            L.push('4. 参数必须是合法 JSON 对象；无参数时写 `{}` 或省略。');
            L.push('5. 未列出的工具说明，以调用时返回的错误为准，不要猜测。');
            L.push('');
            L.push('## 服务总览');
            L.push('');
            if (!servers.length) {
                L.push('（尚未配置任何 MCP 服务）');
            } else {
                L.push('| 服务名 | 工具数 | 地址 |');
                L.push('| --- | --- | --- |');
                for (const s of servers) {
                    const list = Mcp.getTools(s) || [];
                    L.push('| `' + (s.name || s.url) + '` | ' + list.length + ' | ' + s.url + ' |');
                }
            }
            L.push('');
            servers.forEach(function (s, idx) {
                const name = s.name || s.url;
                const list = Mcp.getTools(s) || [];
                L.push('---');
                L.push('');
                L.push('## 服务 ' + (idx + 1) + '：' + name);
                L.push('');
                L.push('> 服务标识（调用时第一行原样使用）：`' + name + '`');
                L.push('> 工具数量：' + list.length);
                L.push('');
                if (!list.length) {
                    L.push('（该服务尚未扫描到工具）');
                    L.push('');
                    return;
                }
                for (const tool of list) {
                    const ro = Mcp.isReadOnly(tool);
                    L.push('### ' + tool.name);
                    L.push('');
                    L.push('- 所属服务：`' + name + '`');
                    L.push('- 权限：' + (ro ? '只读' : '写入（可能修改数据）'));
                    if (tool.description) L.push('- 说明：' + String(tool.description).replace(/\s+/g, ' ').trim());
                    L.push('- 参数：');
                    paramLines(tool.inputSchema).forEach(function (x) { L.push('  ' + x); });
                    L.push('');
                    L.push('调用示例：');
                    L.push('');
                    L.push(F + 'mcp');
                    L.push(name + ' ' + tool.name);
                    L.push(JSON.stringify(schemaSkeleton(tool.inputSchema), null, 2));
                    L.push(F);
                    L.push('');
                }
            });
            L.push('---');
            L.push('');
            L.push('## 易混提醒');
            L.push('');
            L.push('- 判断该用哪个工具时，先看「所属服务」，再看工具名。');
            L.push('- 两个服务有同名工具时，它们是两个不同的工具。');
            L.push('- 若调用返回「工具不存在」，先核对服务名是否与服务总览一致。');
            return L.join('\n');
        }

        /* ---------- 交付：附件 / 复制 / 下载 ---------- */
        function findFileInput() {
            const list = document.querySelectorAll('input[type="file"]');
            for (const el of list) {
                if (!el.disabled) return el;
            }
            return null;
        }

        function attachText(filename, text) {
            const input = findFileInput();
            if (!input) return { ok: false, why: '页面没有文件输入框' };
            if (typeof File === 'undefined' || typeof DataTransfer === 'undefined') {
                return { ok: false, why: '浏览器不支持 File/DataTransfer' };
            }
            try {
                const file = new File([text], filename, { type: 'text/markdown' });
                const dt = new DataTransfer();
                dt.items.add(file);
                input.files = dt.files;
                input.dispatchEvent(new Event('change', { bubbles: true }));
                return { ok: true, size: file.size };
            } catch (e) {
                return { ok: false, why: e.message || String(e) };
            }
        }

        function download(filename, text) {
            try {
                const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
                return true;
            } catch (e) { return false; }
        }

        function copyText(text) {
            try {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                const ok = document.execCommand('copy');
                ta.remove();
                return ok;
            } catch (e) { return false; }
        }

        function attachGuide() {
            const text = buildGuide();
            const r = attachText(PROMPT_FILE, text);
            if (r.ok) {
                UI.showToast('说明已就绪，点发送交给 AI', 'ok');
                return r;
            }
            if (download(PROMPT_FILE, text)) {
                UI.showToast('附件入口不可用，已改为下载', 'err');
                return { ok: true, via: 'download' };
            }
            if (copyText(text)) {
                UI.showToast('已复制说明文本到剪贴板', 'ok');
                return { ok: true, via: 'clipboard' };
            }
            UI.showToast('生成失败：' + r.why, 'err');
            return { ok: false, why: r.why };
        }

        function copyGuide() {
            const text = buildGuide();
            if (copyText(text)) UI.showToast('说明文本已复制（' + text.length + ' 字）', 'ok');
            else UI.showToast('复制失败', 'err');
        }

        /* ---------- 输入框接管 ---------- */
        function findComposer() {
            const areas = document.querySelectorAll('textarea');
            for (const el of areas) {
                if (!el.disabled && !el.readOnly && el.offsetParent !== null) return { el: el, kind: 'textarea' };
            }
            const ces = document.querySelectorAll('[contenteditable="true"]');
            for (const el of ces) {
                if (el.offsetParent !== null) return { el: el, kind: 'ce' };
            }
            return null;
        }

        function setComposerText(c, text) {
            if (!c) return false;
            const el = c.el;
            try { el.focus(); } catch (e) { }
            if (c.kind === 'textarea') {
                const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
                setter.call(el, text);
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.selectionStart = el.selectionEnd = text.length;
                return true;
            }
            try {
                el.textContent = text;
                el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
                return true;
            } catch (e) { return false; }
        }

        function findSendButton(c) {
            if (!c) return null;
            const scope = c.el.closest('form') || c.el.parentElement && c.el.parentElement.parentElement || document.body;
            const direct = scope.querySelectorAll('[data-testid="send-button"], button[aria-label*="发送"], button[aria-label*="Send"]');
            for (const b of direct) if (!b.disabled) return b;
            const roles = scope.querySelectorAll('[role="button"], button');
            const cands = [];
            for (const b of roles) {
                if (b.disabled) continue;
                if (b.querySelector('svg')) cands.push(b);
            }
            return cands.length ? cands[cands.length - 1] : null;
        }

        function clickSend(c) {
            const b = findSendButton(c);
            if (b) { b.click(); return true; }
            try {
                c.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                return true;
            } catch (e) { return false; }
        }

        /* ---------- 系统提示词 ---------- */
        function buildPrompt() {
            const servers = Store.get(STORE_SERVERS, []);
            const names = servers.map(function (s) { return '`' + (s.name || s.url) + '`'; });
            const L = [];
            L.push('【MCP 控制台 · 系统提示词】');
            L.push('你可以通过 ' + fence() + 'mcp 代码块请求调用 MCP 工具，用户会在面板中确认后执行。');
            L.push('格式：第一行「服务名 工具名」，第二行起为 JSON 参数。服务名与工具名必须逐字照抄。');
            if (names.length) L.push('当前服务：' + names.join('、') + '。');
            L.push('不同服务下可能有同名工具，调用前先确认所属服务；不确定时先索要工具说明附件。');
            L.push('用户已附上《MCP-工具调用说明.md》时，以该文件中的服务与工具清单为准。');
            return L.join('\n');
        }

        function conversationKey() {
            const m = location.pathname.match(/\/a\/chat\/s\/([^\/?#]+)/);
            if (m) return 'ds:' + m[1];
            const m2 = location.pathname.match(/\/chat\/s\/([^\/?#]+)/);
            if (m2) return 'ds:' + m2[1];
            return 'ds:root';
        }

        function hasAssistantMessages() {
            return !!document.querySelector('[data-message-author-role="assistant"]');
        }

        function hasUserMessages() {
            return !!document.querySelector('[data-message-author-role="user"]');
        }

        function clearInjection() {
            injectedKeys = {};
        }

        function injectPrompt(andSend) {
            const c = findComposer();
            if (!c) { UI.showToast('未找到输入框', 'err'); return { ok: false, why: 'no composer' }; }
            const cur = c.kind === 'textarea' ? c.el.value : (c.el.textContent || '');
            const merged = buildPrompt() + SEP + (cur.trim() ? cur : '');
            if (!setComposerText(c, merged)) { UI.showToast('写入输入框失败', 'err'); return { ok: false }; }
            injectedKeys[conversationKey()] = Date.now();
            if (!andSend) { UI.showToast('提示词已填入，请手动发送', 'ok'); return { ok: true, sent: false }; }
            const ok = clickSend(c);
            UI.showToast(ok ? '提示词已发送' : '已填入，请手动点发送', ok ? 'ok' : 'err');
            return { ok: ok, sent: ok };
        }

        /* ---------- 会话识别 ---------- */
        function checkSession() {
            const key = conversationKey();
            if (lastKey === null) {
                lastKey = key;
                sawMessages = hasAssistantMessages() || hasUserMessages();
                return;
            }
            if (key !== lastKey) {
                const prev = lastKey;
                lastKey = key;
                sawMessages = hasAssistantMessages() || hasUserMessages();
                if (key === 'ds:root') {
                    UI.resetForNewConversation();
                } else if (prev === 'ds:root') {
                    /* 新对话拿到正式 ID，迁移状态，不重置 */
                } else {
                    UI.resetForNewConversation();
                }
                return;
            }
            const nowHas = hasAssistantMessages() || hasUserMessages();
            if (key === 'ds:root' && sawMessages && !hasUserMessages() && !hasAssistantMessages()) {
                UI.resetForNewConversation();
                sawMessages = false;
                return;
            }
            if (nowHas) sawMessages = true;
        }

        function init() {
            try { checkSession(); } catch (e) { }
            setInterval(function () { try { checkSession(); } catch (e) { } }, 1200);
        }

        return {
            init: init,
            buildGuide: buildGuide,
            attachGuide: attachGuide,
            copyGuide: copyGuide,
            injectPrompt: injectPrompt,
            clearInjection: clearInjection,
            checkSession: checkSession,
            conversationKey: conversationKey
        };
    })();

    /* ============================================================
     * 05-main.js — 启动
     * ============================================================ */

    function boot() {
        UI.mount();
        Channel.init();
        AI.init();
        // 初始扫描服务
        setTimeout(function () { UI.scanAllServers(); }, 2000);
        // 定期重扫
        setInterval(function () { UI.scanAllServers(); }, TOOLS_CACHE_MS);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

})();;
