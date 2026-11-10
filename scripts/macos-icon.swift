// Render the shared artwork into the macOS icon canvas before NSH builds the ICNS.
// Usage: swift scripts/macos-icon.swift app/icon.png /tmp/noop-macos-icon.png
import AppKit

guard CommandLine.arguments.count == 3 else {
    fputs("Usage: macos-icon.swift <source.png> <output.png>\n", stderr)
    exit(1)
}
let sourceURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2])
let source = try Data(contentsOf: sourceURL)
guard let image = NSBitmapImageRep(data: source), image.pixelsWide == image.pixelsHigh,
      let cgImage = image.cgImage else {
    fputs("The source icon must be a square image.\n", stderr)
    exit(1)
}

// Keep the visible tile at 824/1024 of the canvas, rather than adding padding
// separately at each ICNS size. Preserve the original artwork inside the tile.
let size = 1024
let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
                        bytesPerRow: 0, space: colorSpace,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
context.clear(CGRect(x: 0, y: 0, width: size, height: size))
context.addPath(CGPath(roundedRect: tile, cornerWidth: 185, cornerHeight: 185, transform: nil))
context.clip()
context.interpolationQuality = .high
context.draw(cgImage, in: tile)
let result = NSBitmapImageRep(cgImage: context.makeImage()!)
let png = result.representation(using: .png, properties: [:])!
try png.write(to: outputURL, options: .atomic)
