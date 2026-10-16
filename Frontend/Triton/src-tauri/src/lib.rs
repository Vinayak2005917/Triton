use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::Manager;

struct TranscriptionServer(Mutex<Option<Child>>);

impl TranscriptionServer {
    fn stop(&self) {
        if let Ok(mut process) = self.0.lock() {
            if let Some(mut child) = process.take() {
                if matches!(child.try_wait(), Ok(None)) {
                    #[cfg(target_os = "windows")]
                    {
                        use std::os::windows::process::CommandExt;
                        let pid = child.id().to_string();
                        let _ = Command::new("taskkill")
                            .args(["/PID", pid.as_str(), "/T", "/F"])
                            .creation_flags(0x08000000)
                            .status();
                    }
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
    }
}

fn start_transcription_server() -> Option<Child> {
    let backend_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../backend");
    if !backend_dir.is_dir() {
        eprintln!("Could not find Triton's backend directory at {}", backend_dir.display());
        return None;
    }

    let mut command = Command::new("uv");
    command
        .args(["run", "fermion", "serve", "phonon-2", "--port", "8001"])
        .current_dir(backend_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    match command.spawn() {
        Ok(child) => Some(child),
        Err(error) => {
            eprintln!("Could not start the Phonon transcription server: {error}");
            None
        }
    }
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            app.manage(TranscriptionServer(Mutex::new(start_transcription_server())));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet])
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(server) = app_handle.try_state::<TranscriptionServer>() {
                server.stop();
            }
        }
    });
}
