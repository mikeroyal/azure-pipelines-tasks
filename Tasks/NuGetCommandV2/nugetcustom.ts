import * as path from "path";
import * as auth from "nuget-task-common/Authentication";
import * as ngToolRunner from "nuget-task-common/NuGetToolRunner2";
import * as nutil from "nuget-task-common/Utility";
import * as tl from "vsts-task-lib/task";

import peParser = require("nuget-task-common/pe-parser/index");
import * as pkgLocationUtils from "utility-common/packaging/locationUtilities";
import * as telemetry from "utility-common/telemetry";
import {IExecSyncResult} from "vsts-task-lib/toolrunner";

class NuGetExecutionOptions {
    constructor(
        public nuGetPath: string,
        public environment: ngToolRunner.NuGetEnvironmentSettings,
        public args: string,
        public authInfo: auth.NuGetExtendedAuthInfo
    ) { }
}

export async function run(nuGetPath: string): Promise<void> {
    let packagingLocation: pkgLocationUtils.PackagingLocation;
    try {
        packagingLocation = await pkgLocationUtils.getPackagingUris(pkgLocationUtils.ProtocolType.NuGet);
    } catch (error) {
        tl.debug("Unable to get packaging URIs, using default collection URI");
        tl.debug(JSON.stringify(error));
        const collectionUrl = tl.getVariable("System.TeamFoundationCollectionUri");
        packagingLocation = {
            PackagingUris: [collectionUrl],
            DefaultPackagingUri: collectionUrl};
    }

    nutil.setConsoleCodePage();

    const buildIdentityDisplayName: string = null;
    const buildIdentityAccount: string = null;

    const args: string = tl.getInput("arguments", false);

    const version = await peParser.getFileVersionInfoAsync(nuGetPath);
    if(version.productVersion.a < 3 || (version.productVersion.a <= 3 && version.productVersion.b < 5))
    {
        tl.setResult(tl.TaskResult.Failed, tl.loc("Info_NuGetSupportedAfter3_5", version.strings.ProductVersion));
        return;
    }

    try {
        let credProviderPath = nutil.locateCredentialProvider();

        // Clauses ordered in this way to avoid short-circuit evaluation, so the debug info printed by the functions
        // is unconditionally displayed
        const quirks = await ngToolRunner.getNuGetQuirksAsync(nuGetPath);
        const useCredProvider = ngToolRunner.isCredentialProviderEnabled(quirks) && credProviderPath;
        // useCredConfig not placed here: This task will only support NuGet versions >= 3.5.0
        // which support credProvider both hosted and OnPrem

        const accessToken = auth.getSystemAccessToken();
        let urlPrefixes = packagingLocation.PackagingUris;
        tl.debug(`Discovered URL prefixes: ${urlPrefixes}`);

        // Note to readers: This variable will be going away once we have a fix for the location service for
        // customers behind proxies
        const testPrefixes = tl.getVariable("NuGetTasks.ExtraUrlPrefixesForTesting");
        if (testPrefixes) {
            urlPrefixes = urlPrefixes.concat(testPrefixes.split(";"));
            tl.debug(`All URL prefixes: ${urlPrefixes}`);
        }
        let authInfo = new auth.NuGetExtendedAuthInfo(new auth.InternalAuthInfo(urlPrefixes, accessToken, useCredProvider, false), []);
        const environmentSettings: ngToolRunner.NuGetEnvironmentSettings = {
            credProviderFolder: useCredProvider ? path.dirname(credProviderPath) : null,
            extensionsDisabled: true,
        };

        const executionOptions = new NuGetExecutionOptions(
            nuGetPath,
            environmentSettings,
            args,
            authInfo);

        runNuGet(executionOptions);
    } catch (err) {
        tl.error(err);

        if (buildIdentityDisplayName || buildIdentityAccount) {
            tl.warning(tl.loc("BuildIdentityPermissionsHint", buildIdentityDisplayName, buildIdentityAccount));
        }

        tl.setResult(tl.TaskResult.Failed, "");
    }
}

function runNuGet(executionOptions: NuGetExecutionOptions): IExecSyncResult {
    const nugetTool = ngToolRunner.createNuGetToolRunner(
        executionOptions.nuGetPath,
        executionOptions.environment,
        executionOptions.authInfo);
    nugetTool.line(executionOptions.args);
    nugetTool.arg("-NonInteractive");

    const execResult = nugetTool.execSync();
    if (execResult.code !== 0) {
        telemetry.logResult("Packaging", "NuGetCommand", execResult.code);
        throw tl.loc("Error_NugetFailedWithCodeAndErr",
            execResult.code,
            execResult.stderr ? execResult.stderr.trim() : execResult.stderr);
    }
    return execResult;
}