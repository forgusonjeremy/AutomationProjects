/**
 * Action:  selectPowerShellHost
 * Module:  com.broadcom.pso.windows.logs
 *
 * WHAT IT DOES
 *   Decides which PowerShell host runs the script, and only asks when it genuinely
 *   cannot tell.
 *
 *   Most sites register exactly one PowerShell host for this work. When that is the case
 *   there is nothing to choose, so the workflow does not make anyone choose it. If more
 *   than one is registered, the operator's selection is used, and if they did not make
 *   one the run stops with a list of the choices rather than picking at random.
 *
 * INPUTS (in this order)
 *   psHost  PowerShell:PowerShellHost  the host chosen in the request form -- may be empty
 *
 * RETURNS
 *   PowerShell:PowerShellHost
 */

// An explicit choice always wins.
if (psHost !== null && psHost !== undefined) {
    return psHost;
}

var hosts = Server.findAllForType("PowerShell:PowerShellHost");

if (hosts === null || hosts.length === 0) {
    throw new Error(
        "selectPowerShellHost: no PowerShell hosts are registered in Orchestrator. Add one with the " +
        "'Add a PowerShell host' workflow -- see 03_Implementation-Guide.md."
    );
}

if (hosts.length === 1) {
    System.log("Using the only registered PowerShell host: " + hosts[0].name);
    return hosts[0];
}

// More than one, and nobody said which.
var names = [];
for (var i = 0; i < hosts.length; i++) {
    names.push(hosts[i].name);
}

throw new Error(
    "selectPowerShellHost: " + hosts.length + " PowerShell hosts are registered, so the workflow " +
    "cannot tell which one to use. Choose one in the request form. Registered hosts are: " +
    names.join(", ")
);
