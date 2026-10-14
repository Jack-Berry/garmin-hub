// Usage: swift scripts/make-app-icon.swift GarminHub/Assets.xcassets/AppIcon.appiconset/AppIcon.png
import AppKit
import CoreGraphics
import CoreText

let side = 1_024
guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write(Data("usage: make-app-icon.swift <output.png>\n".utf8))
    exit(2)
}

let context = CGContext(
    data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB)!,
    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
)!
context.setFillColor(CGColor(srgbRed: 0.07, green: 0.08, blue: 0.07, alpha: 1))
context.fill(CGRect(x: 0, y: 0, width: side, height: side))

context.setStrokeColor(CGColor(srgbRed: 0.79, green: 0.95, blue: 0.31, alpha: 1))
context.setLineWidth(54)
context.setLineCap(.round)
context.move(to: CGPoint(x: 170, y: 600))
context.addLine(to: CGPoint(x: 350, y: 600))
context.addLine(to: CGPoint(x: 430, y: 390))
context.addLine(to: CGPoint(x: 560, y: 735))
context.addLine(to: CGPoint(x: 650, y: 510))
context.addLine(to: CGPoint(x: 850, y: 510))
context.strokePath()

let font = NSFont.monospacedSystemFont(ofSize: 170, weight: .bold)
let text = NSAttributedString(string: "GH", attributes: [
    .font: font,
    .foregroundColor: NSColor.white,
    .kern: 6,
])
let line = CTLineCreateWithAttributedString(text)
let bounds = CTLineGetBoundsWithOptions(line, .useGlyphPathBounds)
context.textPosition = CGPoint(x: (CGFloat(side) - bounds.width) / 2 - bounds.minX,
                               y: 150 - bounds.minY)
CTLineDraw(line, context)

let image = context.makeImage()!
let rep = NSBitmapImageRep(cgImage: image)
try! rep.representation(using: .png, properties: [:])!
    .write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
