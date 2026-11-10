fn main() {
    // Declare the shell's commands so the board page (served from the local server) can be
    // granted exactly these and nothing else.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
        "pick_folder",
        "notify",
        "set_badge",
        "open_external",
        "start_drag",
        "toggle_maximize",
    ])))
    .expect("failed to run tauri-build");
}
