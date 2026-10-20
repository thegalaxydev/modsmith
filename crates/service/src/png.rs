use std::io::Write;

fn crc32(data: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (n, slot) in table.iter_mut().enumerate() {
        let mut c = n as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
        }
        *slot = c;
    }
    let mut c = 0xffff_ffffu32;
    for b in data {
        c = table[((c ^ *b as u32) & 0xff) as usize] ^ (c >> 8);
    }
    c ^ 0xffff_ffff
}

fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let mut td = kind.to_vec();
    td.extend_from_slice(data);
    out.extend_from_slice(&td);
    out.extend_from_slice(&crc32(&td).to_be_bytes());
}

pub fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
    let stride = width as usize * 4;
    let mut raw = Vec::with_capacity((stride + 1) * height as usize);
    for y in 0..height as usize {
        raw.push(0);
        raw.extend_from_slice(&rgba[y * stride..(y + 1) * stride]);
    }
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::new(6));
    let _ = z.write_all(&raw);
    let idat = z.finish().unwrap_or_default();
    let mut out = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &idat);
    chunk(&mut out, b"IEND", &[]);
    out
}

fn hsl_to_rgb(h: f64, s: f64, l: f64) -> [f64; 3] {
    let hue2rgb = |p: f64, q: f64, mut t: f64| {
        if t < 0.0 {
            t += 1.0;
        }
        if t > 1.0 {
            t -= 1.0;
        }
        if t < 1.0 / 6.0 {
            return p + (q - p) * 6.0 * t;
        }
        if t < 1.0 / 2.0 {
            return q;
        }
        if t < 2.0 / 3.0 {
            return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
        }
        p
    };
    let q = if l < 0.5 { l * (1.0 + s) } else { l + s - l * s };
    let p = 2.0 * l - q;
    [hue2rgb(p, q, h + 1.0 / 3.0) * 255.0, hue2rgb(p, q, h) * 255.0, hue2rgb(p, q, h - 1.0 / 3.0) * 255.0]
}

fn clamp_byte(v: f64) -> u8 {
    let v = v.min(255.0);
    if v.is_nan() || v <= 0.0 {
        0
    } else {
        v as u8
    }
}

pub fn placeholder_texture(seed: &str, item: bool) -> Vec<u8> {
    let mut h: u32 = 2_166_136_261;
    for unit in seed.encode_utf16() {
        h = (h ^ unit as u32).wrapping_mul(16_777_619);
    }
    let hue = h % 360;
    let [r, g, b] = hsl_to_rgb(hue as f64 / 360.0, 0.55, 0.5);
    let mut px = vec![0u8; 16 * 16 * 4];
    for y in 0..16i32 {
        for x in 0..16i32 {
            let i = ((y * 16 + x) * 4) as usize;
            let mut a = 255u8;
            let mut shade = 1.0;
            if item {
                let dx = x as f64 - 7.5;
                let dy = y as f64 - 7.5;
                let d = (dx * dx + dy * dy).sqrt();
                if d > 6.5 {
                    a = 0;
                } else if d > 5.5 {
                    shade = 0.55;
                } else if dx + dy < -3.0 {
                    shade = 1.25;
                }
            } else {
                let edge = x == 0 || y == 0 || x == 15 || y == 15;
                let grid = (x % 4 == 0 || y % 4 == 0) && !edge;
                shade = if edge {
                    0.6
                } else if grid {
                    0.85
                } else {
                    1.0
                };
            }
            px[i] = clamp_byte(r * shade);
            px[i + 1] = clamp_byte(g * shade);
            px[i + 2] = clamp_byte(b * shade);
            px[i + 3] = a;
        }
    }
    encode_png(16, 16, &px)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pixels(png: &[u8]) -> (Vec<u8>, Vec<u8>) {
        use std::io::Read;
        let ihdr = png[16..29].to_vec();
        let len = u32::from_be_bytes([png[33], png[34], png[35], png[36]]) as usize;
        let mut raw = Vec::new();
        flate2::read::ZlibDecoder::new(&png[41..41 + len]).read_to_end(&mut raw).unwrap();
        (ihdr, raw)
    }

    #[test]
    fn matches_node_pixels() {
        let node_item = hex::decode("89504e470d0a1a0a0000000d49484452000000100000001008060000001ff3ff610000005d49444154789c6308b63cca4009a648334e0374e573fe63c3040d80294c77ff8e82832d8f82313683300cc0a519d910ac0610a3199b21380dc0a5992803f06926680021cd780d204633ed0c20d61082e9009f21041312c5497940722300930dbcf8cd95e9fa0000000049454e44ae426082").unwrap();
        let node_block = hex::decode("89504e470d0a1a0a0000000d49484452000000100000001008060000001ff3ff610000002d49444154789c63285372fc4f09660011472d73e078b9410cd1fc41640048901c3c88bc301a06a36140697606002b4b37063658e2dc0000000049454e44ae426082").unwrap();
        assert_eq!(pixels(&placeholder_texture("testmod:example_item", true)), pixels(&node_item));
        assert_eq!(pixels(&placeholder_texture("testmod:icon", false)), pixels(&node_block));
    }
}
