/* ----------------------------------------------------------------------------
 * ACTION: uploadGuestScript
 * IN:  vm {VC:VirtualMachine}, transferUrl {string}, content {string}, tag {string}
 * OUT: void  (throws on failure; both REST hosts created+destroyed here, null-guarded)
 * -------------------------------------------------------------------------- */
var baseUrl       = transferUrl.substring(0, transferUrl.indexOf("/", 8));
var uploadHost    = null;
var transientHost = null;

try {
    uploadHost    = RESTHostManager.createHost("upload-" + tag + "-" + vm.name);
    transientHost = RESTHostManager.createTransientHostFrom(uploadHost);
    RESTHostManager.reloadConfiguration();
    transientHost.url              = baseUrl;
    transientHost.hostVerification = false;

    var req = transientHost.createRequest("PUT", transferUrl, "application/octet-stream");
    req.setContent(content);
    var resp = req.execute();
    if (resp.statusCode !== 200) {
        throw new Error("Script upload failed [" + tag + "]. HTTP " + resp.statusCode + ": " + resp.contentAsString);
    }
    System.log("Script uploaded [" + tag + "].");
} finally {
    if (transientHost) {
        try { RESTHostManager.removeHost(transientHost); }
        catch (err) { System.warn("Transient host cleanup [" + tag + "]: " + err.message); }
    }
    if (uploadHost) {
        try { RESTHostManager.removeHost(uploadHost); }
        catch (err) { System.warn("Upload host cleanup [" + tag + "]: " + err.message); }
    }
}