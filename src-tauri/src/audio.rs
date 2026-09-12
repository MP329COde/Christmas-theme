use rodio::{OutputStream, Sink};
use std::sync::mpsc::{self, Sender};
use std::thread;

/// Ambient sound player.
///
/// `rodio::OutputStream` (and the `cpal` stream it wraps) is not `Send`/`Sync`
/// on some platforms (notably macOS CoreAudio), so it can't live directly in
/// Tauri's managed `State<Mutex<AppState>>` — that requires everything inside
/// to be `Send + Sync`. Instead, the actual audio objects are created and
/// owned entirely by one dedicated thread; IPC commands only hold a
/// `Sender<AudioCommand>` (which is `Send + Sync`) and talk to that thread
/// over a channel.
enum AudioCommand {
    PlayLooping { bytes: &'static [u8], volume: f32 },
    SetVolume(f32),
    Stop,
}

pub struct AmbientPlayer {
    tx: Sender<AudioCommand>,
}

impl AmbientPlayer {
    pub fn new() -> Option<Self> {
        let (tx, rx) = mpsc::channel::<AudioCommand>();

        // Probing for an output device happens on the audio thread too, so
        // a missing/unavailable device doesn't block or fail app startup;
        // commands sent before/without a device are silently dropped.
        thread::Builder::new()
            .name("ambient-audio".into())
            .spawn(move || {
                let Ok((_stream, handle)) = OutputStream::try_default() else {
                    return;
                };
                let mut sink: Option<Sink> = None;

                while let Ok(cmd) = rx.recv() {
                    match cmd {
                        AudioCommand::PlayLooping { bytes, volume } => {
                            if let Ok(new_sink) = Sink::try_new(&handle) {
                                new_sink.set_volume(volume.clamp(0.0, 1.0));
                                if let Ok(source) =
                                    rodio::Decoder::new(std::io::Cursor::new(bytes))
                                {
                                    new_sink.append(rodio::source::Source::repeat_infinite(source));
                                }
                                sink = Some(new_sink);
                            }
                        }
                        AudioCommand::SetVolume(volume) => {
                            if let Some(s) = &sink {
                                s.set_volume(volume.clamp(0.0, 1.0));
                            }
                        }
                        AudioCommand::Stop => {
                            sink = None;
                        }
                    }
                }
            })
            .ok()?;

        Some(Self { tx })
    }

    pub fn play_looping(&self, bytes: &'static [u8], volume: f32) {
        let _ = self.tx.send(AudioCommand::PlayLooping { bytes, volume });
    }

    pub fn set_volume(&self, volume: f32) {
        let _ = self.tx.send(AudioCommand::SetVolume(volume));
    }

    pub fn stop(&self) {
        let _ = self.tx.send(AudioCommand::Stop);
    }
}
