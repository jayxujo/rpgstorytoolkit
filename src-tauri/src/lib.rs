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
            trash_path,
            prune_empty_dirs
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
