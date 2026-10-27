// hangar-server: the core over HTTP on 127.0.0.1, serving the web UI too. The desktop app doesn't use it (it calls
// the core in-process); it exists so the test suites and `npm start` exercise the same code in a plain browser.
// Port 0 = pick a free one; the chosen port is printed as a "HANGAR_PORT=" line on stdout.
use hangar_core::{Config, Hangar};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use tiny_http::{Header, Response, Server};

const STATIC: &[(&str, &str, &str)] = &[
    ("/", "index.html", "text/html; charset=utf-8"),
    ("/i18n.js", "i18n.js", "text/javascript; charset=utf-8"),
    ("/icon.svg", "icon.svg", "image/svg+xml"),
    ("/icon-512.png", "icon-512.png", "image/png"),
    ("/apple-touch-icon.png", "apple-touch-icon.png", "image/png"),
    ("/manifest.webmanifest", "manifest.webmanifest", "application/manifest+json"),
];

fn main() {
    let port: u16 = std::env::var("HANGAR_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(0);
    let web = std::env::var_os("HANGAR_WEB_DIR").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../web"));
    let t0 = Instant::now();
    let hangar = Hangar::open(Config::from_env()).unwrap_or_else(|e| {
        eprintln!("hangar: {e}");
        std::process::exit(1);
    });
    hangar.spawn_background();

    let server = Arc::new(Server::http(("127.0.0.1", port)).unwrap_or_else(|e| {
        eprintln!("hangar: {e}");
        std::process::exit(1);
    }));
    let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(port);
    let hosts = [format!("127.0.0.1:{port}"), format!("localhost:{port}")];
    println!("HANGAR_PORT={port}");
    let _ = std::io::stdout().flush();
    eprintln!("hangar on http://127.0.0.1:{port} (scan {}ms)", t0.elapsed().as_millis());

    for mut req in server.incoming_requests() {
        let (hangar, web, hosts) = (Arc::clone(&hangar), web.clone(), hosts.clone());
        std::thread::spawn(move || {
            let header = |name: &str| req.headers().iter().find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name)).map(|h| h.value.as_str().to_string());
            let reply = |status: u16, body: Vec<u8>, kind: &str| {
                Response::from_data(body)
                    .with_status_code(status)
                    .with_header(Header::from_bytes("content-type", kind).unwrap())
                    .with_header(Header::from_bytes("cache-control", "no-store").unwrap())
            };
            let json = |status: u16, v: serde_json::Value| reply(status, v.to_string().into_bytes(), "application/json");
            let method = req.method().as_str().to_uppercase();
            // DNS-rebinding and CSRF guard: only our own origin, and mutations need a header a cross-site form can't send.
            let res = if !header("host").is_some_and(|h| hosts.contains(&h)) {
                json(403, serde_json::json!({ "error": "host" }))
            } else if method != "GET" && header("x-hangar").as_deref() != Some("1") {
                json(403, serde_json::json!({ "error": "csrf" }))
            } else {
                let path = req.url().split('?').next().unwrap_or("/").to_string();
                if let Some((_, file, kind)) = STATIC.iter().find(|(p, _, _)| *p == path) {
                    match std::fs::read(web.join(file)) {
                        Ok(bytes) => reply(200, bytes, kind),
                        Err(e) => json(500, serde_json::json!({ "error": e.to_string() })),
                    }
                } else {
                    let mut body = String::new();
                    let _ = req.as_reader().take(1_000_000).read_to_string(&mut body);
                    let r = hangar.handle(&method, &path, &body);
                    json(r.status, r.body)
                }
            };
            let _ = req.respond(res);
        });
    }
}
