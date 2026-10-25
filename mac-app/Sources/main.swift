import Cocoa

// Einstiegspunkt der Mac-App
let app = NSApplication.shared
let controller = AppController()
app.delegate = controller
app.setActivationPolicy(.regular)
app.run()
