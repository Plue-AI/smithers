use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;

fn echo(mut stream: TcpStream) -> io::Result<()> {
    stream.set_nodelay(true)?;
    loop {
        let mut header = [0u8; 4];
        match stream.read_exact(&mut header) {
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(()),
            other => other?,
        }
        let n = u32::from_be_bytes(header) as usize;
        if n == 0 || n > 1024 * 1024 {
            return Err(io::Error::other("invalid frame size"));
        }
        let mut data = vec![0; n];
        stream.read_exact(&mut data)?;
        // One write prevents artificial Nagle stalls between header and body.
        let mut frame = header.to_vec();
        frame.extend(data);
        stream.write_all(&frame)?;
    }
}

fn main() -> io::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    let address = &args[2];
    if args[1] == "listen" {
        let listener = TcpListener::bind(address)?;
        for stream in listener.incoming() {
            let stream = stream?;
            thread::spawn(move || {
                if let Err(e) = echo(stream) {
                    eprintln!("echo: {e}");
                }
            });
        }
        Ok(())
    } else if args[1] == "dial" {
        let mut stream = TcpStream::connect(address)?;
        stream.set_nodelay(true)?;
        let marker = b"col01-echo";
        let mut frame = (marker.len() as u32).to_be_bytes().to_vec();
        frame.extend(marker);
        stream.write_all(&frame)?;
        echo(stream)
    } else {
        Err(io::Error::other("expected listen|dial ADDRESS"))
    }
}
