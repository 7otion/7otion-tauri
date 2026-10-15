const COMMANDS: &[&str] = &["load", "run", "begin", "commit", "rollback", "close"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
