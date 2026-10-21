//
//  SafariWebExtensionHandler.swift
//  X Video Downloader (Safari Web Extension)
//
//  This is the native glue object for the Safari Web Extension target. The
//  `safari-web-extension-converter` generates an equivalent file for both the
//  macOS and iOS extension targets; this branded copy can replace it verbatim
//  (it works for both platforms).
//
//  It does almost nothing on purpose: this extension talks entirely between its
//  own background page and content scripts (browser.runtime messaging). The
//  native handler only exists to respond to any `browser.runtime.sendNativeMessage`
//  calls — which this extension does not currently make — so the default echo
//  implementation is all that's needed.
//

import SafariServices
import os.log

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let profile: UUID?
        if #available(macOS 13.0, iOS 16.0, *) {
            profile = request?.userInfo?[SFExtensionProfileKey] as? UUID
        } else {
            profile = request?.userInfo?["profile"] as? UUID
        }

        let message: Any?
        if #available(macOS 11.0, iOS 15.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        os_log(.default, "XVideoDownloader received native message: %@ (profile: %@)",
               String(describing: message), profile?.uuidString ?? "none")

        let response = NSExtensionItem()
        response.userInfo = [ SFExtensionMessageKey: [ "echo": message as Any ] ]

        context.completeRequest(returningItems: [ response ], completionHandler: nil)
    }
}
