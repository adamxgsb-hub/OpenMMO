use axum::{
    body::Bytes,
    extract::State,
    http::header,
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tracing::{error, warn};

/// Re-scan the directory at most this often: the response is identical for
/// every visitor, so the login screen of 5,000 users maps to one disk scan
/// per interval, not one per request.
const CACHE_TTL: Duration = Duration::from_secs(10);

/// Newest N are served; older ones stay on disk but off the login screen.
const MAX_ANNOUNCEMENTS: usize = 50;

/// Cap a single body so one runaway file can't bloat the payload.
const MAX_BODY_BYTES: usize = 64 * 1024;

/// Locale for the frontmatter `title` and for body text before any `[xx]`
/// marker. Untagged single-language files stay valid under this default.
const DEFAULT_LOCALE: &str = "ko";

#[derive(Serialize, Clone)]
struct Translation {
    title: String,
    body: String,
}

#[derive(Serialize, Clone)]
pub struct Announcement {
    id: String,
    date: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    category: Option<String>,
    /// locale code -> localized content; always has at least one entry.
    translations: BTreeMap<String, Translation>,
}

struct CacheInner {
    body: Bytes,
    fetched_at: Option<Instant>,
}

pub struct AnnouncementStore {
    dir: PathBuf,
    cache: Mutex<CacheInner>,
}

impl AnnouncementStore {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            cache: Mutex::new(CacheInner {
                body: Bytes::from_static(b"[]"),
                fetched_at: None,
            }),
        }
    }

    /// Prime the cache so the first visitors after a restart get an instant hit.
    pub async fn warm(&self) {
        let _ = self.body().await;
    }

    /// Serialized JSON response body. Shared as `Bytes` so each of the (many)
    /// callers on the login screen clones a refcount, not the whole payload.
    async fn body(&self) -> Bytes {
        let mut cache = self.cache.lock().await;
        let fresh = cache.fetched_at.is_some_and(|t| t.elapsed() < CACHE_TTL);
        if fresh {
            return cache.body.clone();
        }

        let dir = self.dir.clone();
        let list = tokio::task::spawn_blocking(move || load_announcements(&dir))
            .await
            .unwrap_or_else(|e| {
                error!("announcement load task panicked: {e}");
                Vec::new()
            });
        let json = serde_json::to_string(&list).unwrap_or_else(|_| "[]".to_string());
        cache.body = Bytes::from(json);
        cache.fetched_at = Some(Instant::now());
        cache.body.clone()
    }
}

pub fn announcements_router(store: Arc<AnnouncementStore>) -> Router {
    Router::new()
        .route("/api/announcements", get(list_announcements))
        .with_state(store)
}

async fn list_announcements(State(store): State<Arc<AnnouncementStore>>) -> Response {
    let body = store.body().await;
    ([(header::CONTENT_TYPE, "application/json")], body).into_response()
}

fn load_announcements(dir: &Path) -> Vec<Announcement> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) => {
            if e.kind() != std::io::ErrorKind::NotFound {
                warn!("Failed to read announcements dir {}: {}", dir.display(), e);
            }
            return Vec::new();
        }
    };

    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        // `_`-prefixed files (e.g. _README.md) are notes for the operator.
        if stem.starts_with('_') {
            continue;
        }
        let raw = match std::fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(e) => {
                warn!("Failed to read announcement {}: {}", path.display(), e);
                continue;
            }
        };
        if let Some(a) = parse_announcement(stem, &raw) {
            out.push(a);
        }
    }

    // Newest first; break ties on id so the order is stable across scans.
    out.sort_by(|a, b| b.date.cmp(&a.date).then_with(|| b.id.cmp(&a.id)));
    out.truncate(MAX_ANNOUNCEMENTS);
    out
}

/// A file with no resolvable date is skipped (returns None), which is how
/// `_README.md`-style notes stay off the list even if misnamed.
fn parse_announcement(stem: &str, raw: &str) -> Option<Announcement> {
    let (front, body) = split_frontmatter(raw);

    // Frontmatter: shared `date`/`category`, plus `title` (default locale) and
    // `title_<locale>` per-language titles.
    let mut titles: BTreeMap<String, String> = BTreeMap::new();
    let mut date = None;
    let mut category = None;
    for line in front.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, val)) = line.split_once(':') else {
            continue;
        };
        let val = val.trim();
        let key = key.trim().to_ascii_lowercase();
        match key.as_str() {
            "date" if is_iso_date(val) => date = Some(val.to_string()),
            "category" if !val.is_empty() => category = Some(val.to_string()),
            "title" if !val.is_empty() => {
                titles.insert(DEFAULT_LOCALE.to_string(), val.to_string());
            }
            _ => {
                if let Some(loc) = key.strip_prefix("title_").filter(|l| is_locale(l)) {
                    if !val.is_empty() {
                        titles.insert(loc.to_string(), val.to_string());
                    }
                }
            }
        }
    }

    let date = date.or_else(|| date_from_stem(stem))?;

    let bodies = split_body_locales(&body);
    let translations = build_translations(&date, &titles, bodies);
    if translations.is_empty() {
        return None;
    }

    Some(Announcement {
        id: stem.to_string(),
        date,
        category,
        translations,
    })
}

/// Pairs each locale's body with its title, filling gaps: own title -> first
/// heading of that body -> default-locale title -> the date.
fn build_translations(
    date: &str,
    titles: &BTreeMap<String, String>,
    bodies: BTreeMap<String, String>,
) -> BTreeMap<String, Translation> {
    let mut out = BTreeMap::new();
    for (loc, body) in bodies {
        let title = titles
            .get(&loc)
            .cloned()
            .or_else(|| fallback_title(&body))
            .or_else(|| titles.get(DEFAULT_LOCALE).cloned())
            .unwrap_or_else(|| date.to_string());
        out.insert(loc, Translation { title, body });
    }

    // A title-only announcement (no body sections) still shows in the default
    // locale so short notices don't vanish.
    if out.is_empty() {
        if let Some(title) = titles
            .get(DEFAULT_LOCALE)
            .or_else(|| titles.values().next())
        {
            out.insert(
                DEFAULT_LOCALE.to_string(),
                Translation {
                    title: title.clone(),
                    body: String::new(),
                },
            );
        }
    }
    out
}

/// Splits a body into per-locale sections. Text before the first `[xx]` line
/// belongs to the default locale; each `[xx]` line switches locale. Empty
/// sections are dropped.
fn split_body_locales(body: &str) -> BTreeMap<String, String> {
    let mut sections: BTreeMap<String, Vec<&str>> = BTreeMap::new();
    let mut current = DEFAULT_LOCALE.to_string();
    for line in body.lines() {
        if let Some(loc) = locale_marker(line) {
            current = loc;
            continue;
        }
        sections.entry(current.clone()).or_default().push(line);
    }

    let mut out = BTreeMap::new();
    for (loc, lines) in sections {
        let text = cap_body(lines.join("\n").trim().to_string());
        if !text.is_empty() {
            out.insert(loc, text);
        }
    }
    out
}

/// A line that is exactly `[xx]` (2-3 letters) marks a locale section.
fn locale_marker(line: &str) -> Option<String> {
    let inner = line.trim().strip_prefix('[')?.strip_suffix(']')?.trim();
    let lower = inner.to_ascii_lowercase();
    is_locale(&lower).then_some(lower)
}

fn is_locale(s: &str) -> bool {
    let len = s.chars().count();
    (2..=3).contains(&len) && s.chars().all(|c| c.is_ascii_alphabetic())
}

fn cap_body(mut body: String) -> String {
    if body.len() > MAX_BODY_BYTES {
        let mut end = MAX_BODY_BYTES;
        while end > 0 && !body.is_char_boundary(end) {
            end -= 1;
        }
        body.truncate(end);
    }
    body
}

/// Splits an optional leading `---` frontmatter block from the body. Returns
/// `("", raw)` when there is no well-formed block.
fn split_frontmatter(raw: &str) -> (String, String) {
    let raw = raw.trim_start_matches('\u{feff}');
    let mut lines = raw.lines();
    if lines.next().map(str::trim_end) != Some("---") {
        return (String::new(), raw.to_string());
    }

    let mut front = String::new();
    let mut body = Vec::new();
    let mut closed = false;
    for line in lines {
        if !closed && line.trim_end() == "---" {
            closed = true;
            continue;
        }
        if closed {
            body.push(line);
        } else {
            front.push_str(line);
            front.push('\n');
        }
    }

    if closed {
        (front, body.join("\n"))
    } else {
        (String::new(), raw.to_string())
    }
}

fn fallback_title(body: &str) -> Option<String> {
    body.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|l| l.trim_start_matches('#').trim().to_string())
        .filter(|l| !l.is_empty())
}

fn is_iso_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[5..7].iter().all(u8::is_ascii_digit)
        && b[8..10].iter().all(u8::is_ascii_digit)
}

fn date_from_stem(stem: &str) -> Option<String> {
    let prefix: String = stem.chars().take(10).collect();
    is_iso_date(&prefix).then_some(prefix)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tr<'a>(a: &'a Announcement, loc: &str) -> &'a Translation {
        a.translations.get(loc).expect("locale present")
    }

    #[test]
    fn parses_single_language() {
        let raw = "---\ntitle: Big Update\ndate: 2026-07-21\ncategory: update\n---\nBody line one.\nLine two.";
        let a = parse_announcement("2026-07-21-x", raw).expect("parsed");
        assert_eq!(a.date, "2026-07-21");
        assert_eq!(a.category.as_deref(), Some("update"));
        assert_eq!(a.translations.len(), 1);
        assert_eq!(tr(&a, "ko").title, "Big Update");
        assert_eq!(tr(&a, "ko").body, "Body line one.\nLine two.");
    }

    #[test]
    fn parses_two_languages() {
        let raw = "---\ntitle: 던전 업데이트\ntitle_en: Dungeon Update\ndate: 2026-07-21\n---\n한국어 본문\n[en]\nEnglish body";
        let a = parse_announcement("2026-07-21-x", raw).expect("parsed");
        assert_eq!(a.translations.len(), 2);
        assert_eq!(tr(&a, "ko").title, "던전 업데이트");
        assert_eq!(tr(&a, "ko").body, "한국어 본문");
        assert_eq!(tr(&a, "en").title, "Dungeon Update");
        assert_eq!(tr(&a, "en").body, "English body");
    }

    #[test]
    fn english_title_falls_back_to_its_own_heading() {
        let raw = "---\ndate: 2026-01-02\n---\n한국어\n[en]\n# English Heading\nbody";
        let a = parse_announcement("note", raw).expect("parsed");
        assert_eq!(tr(&a, "en").title, "English Heading");
    }

    #[test]
    fn date_falls_back_to_filename() {
        let a = parse_announcement("2026-01-02-hello", "no frontmatter here").expect("parsed");
        assert_eq!(a.date, "2026-01-02");
        assert_eq!(tr(&a, "ko").title, "no frontmatter here");
        assert!(a.category.is_none());
    }

    #[test]
    fn undated_file_is_skipped() {
        assert!(parse_announcement("README", "just notes, no date").is_none());
    }

    #[test]
    fn frontmatter_date_overrides_filename() {
        let raw = "---\ndate: 2026-05-05\n---\nbody";
        let a = parse_announcement("2020-01-01-old", raw).expect("parsed");
        assert_eq!(a.date, "2026-05-05");
    }

    #[test]
    fn bracketed_body_line_is_not_a_marker() {
        let raw = "---\ndate: 2026-01-02\n---\nsee [link] here";
        let a = parse_announcement("x", raw).expect("parsed");
        assert_eq!(a.translations.len(), 1);
        assert_eq!(tr(&a, "ko").body, "see [link] here");
    }
}
