/**
 * Action: assertDiskUuidEnabled
 * Input:  vm : VcVirtualMachine
 * Output: void  (throws if disk.EnableUUID is not TRUE)
 * Gate:   UUID-based disk correlation requires the guest to expose VMDK UUIDs as
 *         disk serials, which depends on the VM-level setting disk.EnableUUID = TRUE
 *         being present on the template at boot.
 */
if (vm == null) { throw "assertDiskUuidEnabled: vm is null"; }

var KEY = "disk.EnableUUID";
var extra = (vm.config != null) ? vm.config.extraConfig : null;
if (extra == null) {
    throw "assertDiskUuidEnabled: cannot read extraConfig for VM " + vm.name;
}

var found = false;
var value = null;
for (var i = 0; i < extra.length; i++) {
    if (extra[i].key === KEY) {
        value = String(extra[i].value);   // String(x) is safe; avoids the java.lang.String issue
        found = true;
        break;
    }
}

if (!found) {
    throw "assertDiskUuidEnabled: '" + KEY + "' is not set on the template backing VM "
        + vm.name + ". It is mandatory for disk correlation. Set " + KEY
        + " = TRUE in the template's advanced configuration and re-publish the template.";
}
if (value == null || value.toUpperCase() !== "TRUE") {
    throw "assertDiskUuidEnabled: '" + KEY + "' = '" + value + "' on VM " + vm.name
        + " (expected TRUE). Disk correlation cannot proceed.";
}

System.log("Verified " + KEY + " = TRUE on " + vm.name);