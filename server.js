#!/usr/bin/env node
/**
 * YT CLipper web --tiny local server
 * serves index.html and runs yt-dlp + ffmpeg on your machine.
 * no npm packages needed (Node 18+)
 * 
 *      node server.js    -> open http://localhost:3000
 * 
 * Only download content you own or have permission to download
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

const PORT = Number(process.env.PORT) || 3000;
const HOST = "127.0.0.1";
const OUT_DIR = path.join(__dirname,"downloads");
fs.mkdirSync(OUT_DIR,{recursive:true});

// ------- startup checks -----------------
for( const tool of ["yt-dlp", "ffmpeg"] ){
    const r = spawnSync(tool, [tool === "ffmpeg" ? "-version":"--version"]);
    if(r.error) console.warn("WARNING: " + tool + " not found. Please install it first ");
}

// ---------helper------------------------
const TIME_RE = /^\d+(:\d{1,2}){0,2}(\.\d+)?$/;
const QUALITIES = ["best","1080","720","480","360"];
const MIME = {".mp4":"video/mp4", ".mp3":"audio/mpeg", ".m4a":"audio/mp4", ".webm":"video/webm"};

function sendJson(res, status, obj) {
    res.writeHead(status,{"Content-Type":"application/json"});
    res.end(JSON.stringify(obj));
}

function validUrl(u){
    try{
        const p = new URL(u);
        return p.protocol === "http:" || p.protocol === "https:";
    } catch{
        return false;
    }
}

const toSec = (t) => (t ? t.split(":").reduce((a,b) => a * 60 + parseFloat(b),0) : null);

function mmss(sec){
    sec = Math.max(0,Math.round(sec));
    const h = Math.floor(sec/3600), m = Math.floor((sec % 3600)/60), s = sec % 60;
    const pad = (n) => String(n).padStart(2,"0");
    return h ? `${h}:${pad(m)}:${pad(s)}`:`${pad(m)}:${pad(s)}`;
}

function formatSelector(type,quality) {
    if(type === "audio") return "bestaudio/best";
    const cap = quality === "best" ? "" : `[height<=${quality}]`;
    return (
        `bestvideo[vcodec^=avc1]${cap}[ext=mp4]+bestaudio[ext=m4a]/` + 
        `bestvideo${cap}[ext=mp4]+bestaudio[ext=m4a]/bestvideo${cap}+bestaudio/best${cap}/best`
    );
}

// Splits a stream into lines (handeles \n, \r\n and \r lines)
function lineSplitter(cb){
    let buf = "";
    return (chunk) => {
        buf += chunk;
        const parts = buf.split(/\r?\n|\r/);
        buf = parts.pop();
        parts.forEach(cb);
    };
}

function spawnError(cmd,e) {
    return new Error(e.code === "ENOENT" ? `${cmd} is not installed or not on PATH.` : e.message);
}

function removeJobDir(jobDir) {
    fs.rm(jobDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }, (err) => {
        if (err) console.error(`Could not remove temporary download directory ${jobDir}:`, err);
    });
}

//. ------------ process helper ---------------
const isWin = process.platform === "win32";
const active = new Set();

// Spawns a jon in its own process group (Unix) so the whole tree can be stopped.
function spawnJob(cmd,args) {
    const p = spawn(cmd, args, {detached: !isWin});
    active.add(p);
    p.on("close",() => active.delete(p));
    p.on("error",() => active.delete(p));
    return p;
}

// Stop a process AND its childeren (yt-dlp starts ffmpeg itself).
function killTree(p) {
    if (!p || !p.pid || p.exitCode !== null) return;
    try{
        if(isWin) spawn("taskkill",["/pid",String(p.pid),"/T","/F"],{stdio:"ignore"});
        else process.kill(-p.pid,"SIGTERM");
    }catch {
        try {p.kill("SIGTERM");} catch {}
    }
}

function shutdown(){
    for (const p of active) killTree(p);
    process.exit(0);
}
process.on("SIGINT",shutdown);
process.on("SIGTERM",shutdown);

function cleanOldJobs() {
    const cutoff = Date.now() - 24 * 3600 * 1000; // remove jobs older than a day
    for(const d of fs.readdirSync(OUT_DIR)){
        const p = path.join(OUT_DIR, d);
        try{
            if(fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, {recursive: true,force: true});
        }catch {}
    }
}
cleanOldJobs();

// ---------/api/info --------------
function handleInfo(url, res) {
    if (!validUrl(url)) return sendJson(res,400, { error: "Enter a valid HTTP(S) URL." });

    const p = spawn("yt-dlp", ["-J", "--no-playlist", "--no-warnings", "--", url]);
    let out = "", err = "";
    let responded = false;
    const respond = (status, data) => {
        if (responded) return;
        responded = true;
        sendJson(res, status, data);
    };
    p.stdout.setEncoding("utf8");
    p.stderr.setEncoding("utf8");
    p.stdout.on("data",(d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => respond(500, {error: spawnError("yt-dlp", e).message}));
    p.on("close",(code) => {
        if(code !== 0) return respond(400, {error: err.trim().split("\n").pop() || "Could not load video."});
        try{
            const i = JSON.parse(out);
            respond(200,{
                id:i.id,
                extractor: i.extractor_key || "",
                title: i.title,
                duration: i.duration || null,
                thumbnail: i.thumbnail || null,
                uploader: i.uploader || null,
            });
        }catch {
            respond(500, { error: "Could not read video info." });
        }
    })
}

// ---------------- /api/download (Server-Sent Event) ---------------
function handleDownload(q, req, res) {
    const url = q.get("url") || "";
    const type = q.get("type") === "audio" ? "audio" : "video";
    const quality = QUALITIES.includes(q.get("quality")) ? q.get("quality") : "best";
    const start = (q.get("start") || "").trim();
    const end = (q.get("end") || "").trim();
    const fast = q.get("fast") === "1";

    if(!validUrl(url)) return sendJson(res, 400, {error: "Invalid URL."});
    if((start && !TIME_RE.test(start)) || (end && !TIME_RE.test(end))) {
        return sendJson(res,400, { error: "Invalid time format." });
    }

    const id = crypto.randomBytes(8).toString("hex");
    const jobDir = path.join(OUT_DIR,id);
    fs.mkdirSync(jobDir,{ recursive: true });

    res.writeHead(200, {
        "Content-Type" : "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });
    const send = (event,data) => {
        if(!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const trimmed = Boolean(start || end);
    let current = null;
    let cancelled = false;
    let finished = false;

    // Start a child process for this job (refuses to start once cancelled)
    const run = (cmd,args) => {
        if(cancelled) throw new Error("Cancelled");
        const p = spawnJob(cmd,args);
        current = p;
        return p;
    };

    // Brower cancelled / refreshed / closed the tab -> stop everything and delete the files
    res.on("close", () => {
        if(finished) return;
        cancelled = true;
        const wipe = () => removeJobDir(jobDir);
        const p = current;
        if (p && p.exitCode === null){
            killTree(p);
            p.once("close", () => setTimeout(wipe,200));
            setTimeout(wipe,5000); // safty net 
        }else{
            wipe();
        }
    });

    const restDir = () => {
        fs.rmSync(jobDir, { recursive: true, force: true } );
        fs.mkdirSync(jobDir, { recursive: true });
    };

    const pickFile = () => {
        const files = fs
            .readdirSync(jobDir)
            .filter((f) => !/\.(part|ytdl|temp)$/i.test(f) && !f.includes(".part") && !/\.f\d+\.\w+$/.test(f));
        const want = type === "audio" ? ".mp3" : ".mp4";
        return files.find((f) => f.toLowerCase().endsWith(want)) || files[0];
    };

    // --------- Method A (clip): resolve stream URLs with yt-dlp, cut with ffmpeg ourselves.
    // ffmpeg reports exact progress so the bar is real.
    async function trimDirect() {
        send("status", {message: "Resolving stream..."});
        send("progress", {percent:null});

        const info = await new Promise((resolve, reject) => {
            const p = run("yt-dlp",[
                "-J", "--no-playlist", "--no-warnings", "-f", formatSelector(type, quality), "--",url,
            ]);
            let out = "", err = "";
            p.stdout.setEncoding("utf8");
            p.stderr.setEncoding("utf8");
            p.stdout.on("data", (d) => (out += d));
            p.stderr.on("data", (d) => (err += d));
            p.on("error",(e) => reject(spawnError("yt-dlp",e)));
            p.on("close",(code) => {
                if (code !== 0) return reject(new Error(err.trim().split("\n").pop() || "yt-dlp failed"));
                try { resolve(JSON.parse(out)); } catch { reject(new Error("Could not read stream info.")) }
            });
        });

        const fmts = info.requested_formats || [info];
        const startSec = toSec(start) || 0;
        let endSec = toSec(end);
        if(endSec == null || (info.duration && endSec > info.duration)) endSec = info.duration || null;
        if(endSec == null) throw new Error("Unknow video length.");
        const clipDur = endSec - startSec;
        if(!(clipDur > 0)){
            const err = new Error("Start time is past the end of the video.");
            err.fatal = true // no pont trying the fallback
            throw err;
        }

        // Build ffmpeg command
        const args = ["-hide_banner","-loglevel","error","-nostdin","-y","-progress","pipe:1","-nostats"];
        fmts.forEach((f) => {
            const header = Object.entries(f.http_headers || {}).map(([k, v]) => `${k}: ${v}\r\n`).join("");
            if(header) args.push("-headers",header);
            args.push("-ss",String(startSec),"-t",String(clipDur), "-i", f.url);
        });

        const hasV = (f) => f.vcodec && f.vcodec !== "none";
        const hasA = (f) => f.acodec && f.acodec !== "none";
        const safe = 
            (info.title || "video")
                .replace(/[\\/:*?"<>|\x00-\x1f]/g,"_")
                .replace(/\s+/g, "")
                .trim()
                .slice(0, 150)
                .replace(/[. ]+$/,"") || "video";
        let copyMode = false;
        const outName = `${safe} (clip).${type === "audio" ? "mp3" : "mp4"}`;
        const outPath = path.join(jobDir, outName);

        if(type === "audio") {
            const ai = fmts.findIndex(hasA);
            args.push("-map",`${ai < 0 ? 0 : ai}:a:0`,"-vn","-c:a","libmp3lame","-q:a","2");
        }else{
            const vi = fmts.findIndex(hasV), ai = fmts.findIndex(hasA);
            args.push("-map",`${vi < 0 ? 0 : vi}:v:0`);
            if (ai >= 0) args.push("-map",  `${ai}:a:0`);
            const vf = fmts[vi < 0 ? 0: vi];
            const canCopy = 
                fast && 
                String(vf.vcodec || "").startsWith("avc1") &&
                (ai < 0 || String(fmts[ai].acodec || "").startsWith("mp4a"));
            if(canCopy){
                copyMode = true;
                args.push("-c", "copy", "-avoid_negative_ts", "make_zero", "-movflags", "+faststart");
            }  else {
                args.push(
                    "-c:v", "libx264","-preset","veryfast","-crf","20","-pix_fmt","yuv420p",
                    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"
                );
            }
        }
        args.push(outPath);

        const t0 = Date.now();
        send("status",{
            message: copyMode ? "Cutting clip (fast copy)..." : type === "audio" ? "Cutting clip..." : "Cutting clip (re-encoding)...",
        });
        console.log(`[clip] ${copyMode ? "copy" : "encode"} ${startSec}s +${clipDur}s`);
        send("progress", {percent:0, speed: "", eta: ""});

        await new Promise((resolve, reject) => {
            const p = run("ffmpeg", args);
            let speedX = 0;
            let errTail = [];
            p.stdout.setEncoding("utf8");
            p.stderr.setEncoding("utf8");
            p.stdout.on(
                "data",
                lineSplitter((line) => {
                    const i = line.indexOf("=");
                    if(i < 0) return;
                    const k = line.slice(0,i), v = line.slice(i + 1).trim();
                    if(k === "speed") {
                        const n = parseFloat(v);
                        if(n > 0) speedX = n;
                    } else if (k === "out_time_us" || k === "out_time_ms") {
                        const t = Number(v) / 1e6;
                        if (Number.isFinite(t) && t >= 0){
                            send("progress", {
                                percent: Math.min(99.9, (t / clipDur) * 100),
                                speed: speedX ? `${speedX.toFixed(1)}x speed` : "",
                                eta: speedX ? mmss((clipDur - t) / speedX) : "",
                            });
                        }
                    } else if (k === "progress" && v === "end") {
                        send("progress", {percent:100, speed: "", eta: ""});
                    }
                })
            );
            p.stderr.on("data", lineSplitter((l) => l.trim() && (errTail = [...errTail.slice(-4), l.trim()])));
            p.on("error", (e) => reject(spawnError("ffmpeg",e)));
            p.on("close", (code) => 
                code === 0 ? resolve() : reject(new Error(errTail.join("\n") || `ffmpeg exited with code ${code}`))  
            );
        });

        console.log(`[clip] finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        return outName;
    }

    // ------- Method B: plain yt-dlp (full downloads, and fallback for clip)
    async function ytdlpDownload() {
        const args = [
            "--no-playlist",
            "--no-warnings",
            "--newline",
            "--progress-template",
            "download:P|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
            "-o",
            path.join(jobDir, "%(title).150B.%(ext)s"),
        ];

        if (type === "audio") {
            args.push("-f", formatSelector("audio"), "-x", "--audio-format", "mp3", "--audio-quality", "0");
        } else {
            args.push("-f", formatSelector(type, quality),"--merge-output-format","mp4");
        }
        if (trimmed) {
            args.push("--download-sections",`*${start || "0"}-${end || "inf"}`, "--force-keyframes-at-cuts");
        }
        args.push("--",url);

        send("status", {message:trimmed ? "Downloading clip..." : "Starting download..."});

        await new Promise((resolve, reject) => {
            const p = run("yt-dlp", args);
            let errTail = [];
            p.stdout.setEncoding("utf8");
            p.stderr.setEncoding("utf8");

            p.stdout.on(
                "data",
                lineSplitter((line) => {
                    line = line.trim();
                    if(!line) return;
                    if(line.startsWith("P|")){
                        const [,pct,speed = "",eta = ""] = line.split("|");
                        const n = parseFloat(pct);
                        send("progress",{percent : isNaN(n) ? null : n, speed: speed.trim(), eta: eta.trim()});
                    }else if (/\[(Merger|ExtractAudio|VideoConvertor)\]/.test(line)) {
                        send("status", {message: "Processing with ffmpeg..."});
                    }
                })
            );
            p.stderr.on(
                "data",
                lineSplitter((line) => {
                    line = line.trim();
                    if(!line) return;
                    const m = line.match(/time=(\d+):(\d\d):(\d\d(?:\.\d+)?)/); // ffmpeg stats (clip fallback)
                    if(m) {
                        const t = +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]);
                        send("status", { message: `Cutting clip... ${mmss(t)} processed`});
                    }else {
                        errTail = [...errTail.slice(-4), line];
                    }
                })
            );
            p.on("error", (e) => reject(spawnError("yt-dlp",e)));
            p.on("close",(code) => 
                code === 0 ? resolve() : reject(new Error(errTail.join("\n") || `yt-dlp exited with code ${code}`))
            );
        });

        return pickFile();
    }

    //--run
    (async () => {
        try{
            let name;
            if(trimmed){
                try{
                    name = await trimDirect();
                }catch(e) {
                    if (cancelled) return; 
                    if (e.fatal) throw e;
                    console.warn("[direct clip failed -> fallback]",e.message);
                    send("status",{message: "Switching to fallback method..."});
                    send("progress", { percent: null });
                    restDir();
                    name = await ytdlpDownload();
                }
            }else{
                name = await ytdlpDownload();
            }
            if (cancelled) return;
            if(!name || !fs.existsSync(path.join(jobDir,name))){
                throw new Error("Download finished but no file was produced.");
            }
            finished = true;
            send("done",{name, url:`/files/${id}/${encodeURIComponent(name)}` });
        }catch(e) {
            if(!cancelled) {
                finished = true;
                send("fail",{message: e.message});
                removeJobDir(jobDir);
            }
        }finally{
            finished = true;
            res.end();
        }
    })();
}

// ----- /failes/<id>/<name> ----------
function handleFile(pathname, res){
    const m = pathname.match(/^\/files\/([a-f0-9]{16})\/(.+)$/);
    if(!m) return sendJson(res,404, { error: "Not found" });

    const name = path.basename(decodeURIComponent(m[2]));
    const full = path.join(OUT_DIR, m[1], name);
    if (!full.startsWith(OUT_DIR + path.sep) || !fs.existsSync(full)) {
        return sendJson(res, 404, {error: "File not found"});
    }
    const stat = fs.statSync(full);
    res.writeHead(200, {
        "Content-Type": MIME[path.extname(name).toLowerCase()] || "application/octet-stream",
        "Content-Length": stat.size,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    });
    const fileStream = fs.createReadStream(full);
    fileStream.on("error", (err) => {
        console.error(`Could not read temporary download ${full}:`, err);
        if (!res.headersSent) sendJson(res, 500, {error: "Could not read the temporary download."});
        else res.destroy(err);
    });
    fileStream.pipe(res);

    // Remove the temporary copy whether the browser finished or canceled the transfer.
    res.on("close", () => {
        fileStream.destroy();
        removeJobDir(path.join(OUT_DIR, m[1]));
    });
}

// --------- router --------------
const server = http.createServer((req, res) => {
    // Block requests from other websites / hostnames (DNS-rebinding & CSRF protection)
    const host = (req.headers.host || "").toLowerCase();
    if(host !== `localhost:${PORT}` && host !== `127.0.0.1:${PORT}`) {
        res.writeHead(403);
        return res.end("Forbidden");
    }

    const u = new URL(req.url, `http://${host}`);

    if(req.method === "GET" && u.pathname === "/"){
        return fs.readFile(path.join(__dirname, "index.html"), (err, html) => {
            if(err) return sendJson(res, 500, {error: "index.html not found next to server.js"});
            res.writeHead(200, {"Content-Type":"text/html; charset=utf-8"});
            res.end(html);
        })
    }
    if(req.method === "GET" && u.pathname === "/api/info") return handleInfo(u.searchParams.get("url") || "", res);
    if(req.method === "GET" && u.pathname === "/api/download") return handleDownload(u.searchParams, req, res);
    if(req.method === "GET" && u.pathname.startsWith("/files/")) return handleFile(u.pathname, res);

    sendJson(res, 404, {error: "Not found"});
});

server.listen(PORT, HOST, () => {
    console.log(`YT Clipper running -> http://localhost:${PORT}`);
    console.log(`Files are saved in: ${OUT_DIR}`)
})