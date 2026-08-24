use std::fs;
use std::path::Path;
use base64::{Engine, engine::general_purpose::STANDARD};

#[tauri::command]
fn file_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_dir_all(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_file_base64(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(STANDARD.encode(bytes))
}

#[tauri::command]
fn write_file_base64(path: String, data: String) -> Result<(), String> {
    let bytes = STANDARD.decode(&data).map_err(|e| e.to_string())?;
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_file(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.exists() {
        fs::remove_file(p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn rename_path(from: String, to: String) -> Result<(), String> {
    if Path::new(&from).exists() {
        fs::rename(&from, &to).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// Recursively copies `from` into `to` (both directories), skipping symlinks.
fn copy_dir_recursive(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let dest = to.join(entry.file_name());
        if file_type.is_symlink() {
            continue;
        } else if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &dest)?;
        } else {
            fs::copy(entry.path(), &dest)?;
        }
    }
    Ok(())
}

// Moves a directory to a new path. Tries a plain rename first (instant, same
// filesystem); std::fs::rename can't cross filesystems/drives, so on failure
// this falls back to a recursive copy + remove of the original. The original
// is only removed after the copy fully succeeds, so a failed move never loses data.
#[tauri::command]
fn move_dir(from: String, to: String) -> Result<(), String> {
    let from_path = Path::new(&from);
    let to_path = Path::new(&to);
    if !from_path.exists() {
        return Err("Source folder does not exist".into());
    }
    if to_path.exists() {
        return Err("Destination already exists".into());
    }
    if fs::rename(from_path, to_path).is_ok() {
        return Ok(());
    }
    if let Err(e) = copy_dir_recursive(from_path, to_path) {
        let _ = fs::remove_dir_all(to_path);
        return Err(e.to_string());
    }
    fs::remove_dir_all(from_path)
        .map_err(|e| format!("Copied to the new location but failed to remove the original: {e}"))
}

#[tauri::command]
fn trash_path(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.exists() {
        trash::delete(p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// Recursively removes empty subdirectories inside `path`, but never removes `path` itself.
fn prune_empty(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    let mut is_empty = true;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let child = entry.path();
            if child.is_dir() {
                if prune_empty(&child) {
                    let _ = fs::remove_dir(&child);
                } else {
                    is_empty = false;
                }
            } else {
                is_empty = false;
            }
        }
    }
    is_empty
}

#[tauri::command]
fn prune_empty_dirs(path: String) -> Result<(), String> {
    prune_empty(Path::new(&path));
    Ok(())
}

// Open an http(s) URL in the user's default browser (no extra plugin needed).
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Only http(s) URLs are allowed".into());
    }
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(target_os = "windows")]
    let spawned = std::process::Command::new("cmd").args(["/C", "start", "", &url]).spawn();
    #[cfg(target_os = "linux")]
    let spawned = std::process::Command::new("xdg-open").arg(&url).spawn();
    spawned.map(|_| ()).map_err(|e| e.to_string())
}

// Non-recursive list of entry names (files + dirs) directly inside `path`.
#[tauri::command]
fn list_dir(path: String) -> Result<Vec<String>, String> {
    let p = Path::new(&path);
    if !p.is_dir() {
        return Ok(vec![]);
    }
    let mut names = Vec::new();
    for entry in fs::read_dir(p).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if let Some(name) = entry.file_name().to_str() {
            names.push(name.to_string());
        }
    }
    Ok(names)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            file_exists,
            read_file,
            write_file,
            create_dir_all,
            read_file_base64,
            write_file_base64,
            delete_file,
            rename_path,
            move_dir,
            trash_path,
            prune_empty_dirs,
            list_dir,
            open_url
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
