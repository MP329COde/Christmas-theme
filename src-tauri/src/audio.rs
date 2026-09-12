use rodio::{OutputStream, OutputStreamHandle, Sink};
use std::sync::Mutex;

/// Ambient sound player. Kept behind a mutex since it's shared across
/// IPC command invocations from the settings window.
pub struct AmbientPlayer {
    _stream: OutputStream,
    handle: OutputStreamHandle,
    sink: Mutex<Option<Sink>>,
}

impl AmbientPlayer {
    pub fn new() -> Option<Self> {
        let (stream, handle) = OutputStream::try_default().ok()?;
        Some(Self {
            _stream: stream,
            handle,
            sink: Mutex::new(None),
        })
    }

    pub fn play_looping(&self, bytes: &'static [u8], volume: f32) {
        let Ok(sink) = Sink::try_new(&self.handle) else {
            return;
        };
        sink.set_volume(volume.clamp(0.0, 1.0));
        if let Ok(source) = rodio::Decoder::new(std::io::Cursor::new(bytes)) {
            sink.append(rodio::source::Source::repeat_infinite(source));
        }
        *self.sink.lock().unwrap() = Some(sink);
    }

    pub fn set_volume(&self, volume: f32) {
        if let Some(sink) = self.sink.lock().unwrap().as_ref() {
            sink.set_volume(volume.clamp(0.0, 1.0));
        }
    }

    pub fn stop(&self) {
        *self.sink.lock().unwrap() = None;
    }
}
