/**
 * Action: getRunAsAccountSelectors
 * Module:  com.broadcom.pso.vcf.powershell.identity   (SHARED - reference, do not copy)
 *
 * vRO input-parameter order (positional call):
 *   (accountCategoryPath)
 *
 * Purpose:
 *   Returns the list of run-as account selectors, for binding to a workflow input's
 *   "predefined list of elements" so the operator PICKS an account instead of typing one.
 *
 *   This is the vRO equivalent of choosing a credential on an AAP job template - the same
 *   decision, made in the same place, from a list of the same length.
 *
 *   Bind it as the value list on the workflow's runAsAccount input; the chosen value goes
 *   to resolvePowerShellHostForAccount, which reads the same category.
 *
 * ── Why a dropdown and not free text ──────────────────────────────────────────
 *   A typo in an account name fails at resolution, which is fine, but a typo that happens
 *   to match a DIFFERENT mapped account does not fail at all - it runs the report as the
 *   wrong identity and returns a plausible, wrong answer. There are only ever a handful of
 *   these values and they change rarely, so there is no reason for anyone to type one.
 *
 *   The list is read from the Configuration Elements rather than hardcoded here, so adding
 *   an account is a configuration change and the dropdown, the resolver and the deployment
 *   cannot disagree about what exists.
 *
 * Inputs:
 *   accountCategoryPath (string) - e.g. 'PSO/Identity/RunAsAccounts'
 *
 * Returns: Array/string - selectors, sorted, safe to bind directly to an input value list.
 *
 * NOTE: this action must NOT throw on an empty or missing category. It runs while the
 * request form is being rendered, and an exception there produces an input the operator
 * cannot use and a message they cannot see. It logs and returns an empty list; the resolver
 * is where a missing mapping becomes a hard failure, with a message the run history keeps.
 */

var selectors = [];

if (!accountCategoryPath || String(accountCategoryPath).trim() === "") {
    System.warn("getRunAsAccountSelectors | accountCategoryPath is empty - returning an empty list.");
    return selectors;
}

var wantCategory = String(accountCategoryPath).trim().replace(/^\/+|\/+$/g, "");
var category = Server.getConfigurationElementCategoryWithPath(wantCategory);

if (category === null || category === undefined) {
    System.warn(
        "getRunAsAccountSelectors | no Configuration Element category at '" + wantCategory + "' - returning " +
        "an empty list. Create one element per run-as account, named for the account, each with a " +
        "'psHostName' attribute."
    );
    return selectors;
}

var elements = category.configurationElements || [];
for (var i = 0; i < elements.length; i++) {
    var name = String(elements[i].name).trim();
    if (name === "") { continue; }

    // Surface a broken mapping in the LIST rather than letting the operator pick it and
    // discover at run time that it resolves to nothing. It is still offered - hiding it
    // would make a misconfigured account simply vanish, which is harder to diagnose than
    // one that fails with a clear message.
    var hostAttr = elements[i].getAttributeWithKey("psHostName");
    if (hostAttr === null || hostAttr === undefined || hostAttr.value === null ||
        String(hostAttr.value).trim() === "") {
        System.warn(
            "getRunAsAccountSelectors | '" + name + "' has no 'psHostName' attribute. It is listed, but " +
            "selecting it will fail at resolution."
        );
    }

    selectors.push(name);
}

selectors.sort();

System.log(
    "getRunAsAccountSelectors | category=" + wantCategory +
    " | " + selectors.length + " account(s): " + (selectors.length ? selectors.join(", ") : "(none)")
);

return selectors;
