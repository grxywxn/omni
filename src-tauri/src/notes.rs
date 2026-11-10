//! Notes vault: plain files in a folder the user chooses (Obsidian-compatible).
//! Every path from the UI is relative to the vault root and is checked so it can
//! never escape the vault.

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::Manager;

fn resolve(root: &str, rel: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(root);
    if !root.is_dir() {
        return Err("The notes folder doesn't exist any more.".into());
    }
    let rel = rel.replace('\\', "/");
    let mut out = root.clone();
    for c in Path::new(&rel).components() {
        match c {
            Component::Normal(p) => out.push(p),
            Component::CurDir => {}
            _ => return Err(format!("Invalid path: {rel}")),
        }
    }
    Ok(out)
}

fn rel_of(root: &Path, p: &Path) -> String {
    p.strip_prefix(root).unwrap_or(p).to_string_lossy().replace('\\', "/")
}

fn mtime(p: &Path) -> u64 {
    fs::metadata(p).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn skip_dir(name: &str) -> bool {
    name.starts_with('.') || name == "node_modules"
}

#[derive(Serialize)]
pub struct Entry {
    path: String,
    is_dir: bool,
    mtime: u64,
    size: u64,
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<Entry>, depth: usize) {
    if depth > 24 {
        return;
    }
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        let Ok(meta) = e.metadata() else { continue };
        if meta.is_dir() {
            if skip_dir(&name) {
                continue;
            }
            out.push(Entry { path: rel_of(root, &p), is_dir: true, mtime: mtime(&p), size: 0 });
            walk(root, &p, out, depth + 1);
        } else {
            if name.starts_with('.') {
                continue;
            }
            out.push(Entry { path: rel_of(root, &p), is_dir: false, mtime: mtime(&p), size: meta.len() });
        }
    }
}

/// Every folder and file in the vault (hidden folders like .obsidian/.trash skipped).
#[tauri::command]
pub async fn vault_scan(app: tauri::AppHandle, root: String) -> Result<Vec<Entry>, String> {
    let r = PathBuf::from(&root);
    if !r.is_dir() {
        return Err("The notes folder doesn't exist any more.".into());
    }
    let _ = app.asset_protocol_scope().allow_directory(&r, true);
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        walk(&r, &r, &mut out, 0);
        out
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct NoteFile {
    path: String,
    content: String,
    mtime: u64,
}

/// Contents of every Markdown note, for search, backlinks, tags and the graph.
#[tauri::command]
pub async fn vault_read_all(root: String) -> Result<Vec<NoteFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let r = PathBuf::from(&root);
        let mut entries = Vec::new();
        walk(&r, &r, &mut entries, 0);
        entries
            .into_iter()
            .filter(|e| !e.is_dir && e.path.to_lowercase().ends_with(".md") && e.size < 5_000_000)
            .filter_map(|e| {
                let p = r.join(&e.path);
                fs::read_to_string(&p).ok().map(|content| NoteFile { path: e.path, content, mtime: e.mtime })
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn note_read(root: String, path: String) -> Result<NoteFile, String> {
    let p = resolve(&root, &path)?;
    let content = fs::read_to_string(&p).map_err(|e| format!("Can't open {path}: {e}"))?;
    Ok(NoteFile { path, content, mtime: mtime(&p) })
}

/// Read a file if it exists (used for small sidecar files like comments).
#[tauri::command]
pub fn note_read_opt(root: String, path: String) -> Result<Option<String>, String> {
    let p = resolve(&root, &path)?;
    Ok(fs::read_to_string(&p).ok())
}

/// Safe write: write to a temp file then rename, so a crash never leaves a half-written note.
#[tauri::command]
pub fn note_write(root: String, path: String, content: String) -> Result<u64, String> {
    let p = resolve(&root, &path)?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_extension("omni-tmp");
    fs::write(&tmp, content.as_bytes()).map_err(|e| format!("Can't save {path}: {e}"))?;
    fs::rename(&tmp, &p).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Can't save {path}: {e}")
    })?;
    Ok(mtime(&p))
}

#[tauri::command]
pub fn note_mtime(root: String, path: String) -> Result<u64, String> {
    Ok(mtime(&resolve(&root, &path)?))
}

/// Create a folder (and parents).
#[tauri::command]
pub fn dir_create(root: String, path: String) -> Result<(), String> {
    fs::create_dir_all(resolve(&root, &path)?).map_err(|e| e.to_string())
}

/// Rename or move a file/folder inside the vault.
#[tauri::command]
pub fn path_move(root: String, from: String, to: String) -> Result<(), String> {
    let a = resolve(&root, &from)?;
    let b = resolve(&root, &to)?;
    if b.exists() {
        return Err(format!("“{to}” already exists."));
    }
    if let Some(parent) = b.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(&a, &b).map_err(|e| e.to_string())
}

/// "Delete" by moving into the vault's .trash folder (same as Obsidian), so nothing is lost.
#[tauri::command]
pub fn path_trash(root: String, path: String) -> Result<(), String> {
    let src = resolve(&root, &path)?;
    let trash = PathBuf::from(&root).join(".trash");
    fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
    let name = src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "item".into());
    let mut dest = trash.join(&name);
    let mut i = 1;
    while dest.exists() {
        dest = trash.join(format!("{i} {name}"));
        i += 1;
    }
    fs::rename(&src, &dest).map_err(|e| e.to_string())
}

fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut map = [255u8; 256];
    for (i, &c) in T.iter().enumerate() {
        map[c as usize] = i as u8;
    }
    let clean: Vec<u8> = s.bytes().filter(|b| !b" \r\n\t=".contains(b)).collect();
    let mut out = Vec::with_capacity(clean.len() * 3 / 4);
    for chunk in clean.chunks(4) {
        let mut v = [0u8; 4];
        for (i, &c) in chunk.iter().enumerate() {
            let d = map[c as usize];
            if d == 255 {
                return Err("bad base64".into());
            }
            v[i] = d;
        }
        out.push((v[0] << 2) | (v[1] >> 4));
        if chunk.len() > 2 {
            out.push((v[1] << 4) | (v[2] >> 2));
        }
        if chunk.len() > 3 {
            out.push((v[2] << 6) | v[3]);
        }
    }
    Ok(out)
}

/// Save binary data (pasted images) into the vault.
#[tauri::command]
pub fn file_write_base64(root: String, path: String, data: String) -> Result<(), String> {
    let p = resolve(&root, &path)?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&p, b64_decode(&data)?).map_err(|e| e.to_string())
}

/// Save an export (.docx / .md / .html) to a path the user picked in a Save dialog.
#[tauri::command]
pub fn export_write(path: String, data: String, base64: bool) -> Result<(), String> {
    let bytes = if base64 { b64_decode(&data)? } else { data.into_bytes() };
    fs::write(&path, bytes).map_err(|e| e.to_string())
}

/// List one folder including hidden ones (used for snapshots in .omni/).
#[tauri::command]
pub fn dir_list(root: String, path: String) -> Result<Vec<Entry>, String> {
    let p = resolve(&root, &path)?;
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(&p) {
        for e in rd.flatten() {
            let ep = e.path();
            let md = e.metadata().ok();
            out.push(Entry { path: rel_of(Path::new(&root), &ep), is_dir: ep.is_dir(), mtime: mtime(&ep), size: md.map(|m| m.len()).unwrap_or(0) });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_escape() {
        let tmp = std::env::temp_dir();
        let r = tmp.to_string_lossy().to_string();
        assert!(resolve(&r, "../x.md").is_err());
        assert!(resolve(&r, "a/../../x.md").is_err());
        assert!(resolve(&r, "a/b.md").is_ok());
    }
    #[test]
    fn base64() {
        assert_eq!(b64_decode("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(b64_decode("aGk=").unwrap(), b"hi");
    }
}
