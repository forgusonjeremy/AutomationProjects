




#!/usr/bin/env python

import sys, getopt, os, errno, json, subprocess, tempfile

def usage():
    print ("""Usage: %s
    Performs onboarding\offboarding to WDATP locally
""" % sys.argv[0])
    pass

try:
    opts, args = getopt.getopt(sys.argv[1:], 'hc', ['help', 'config='])

    for k, v in opts:
        if k == '-h' or k == '--help':
            usage()
            sys.exit(0)

except getopt.GetoptError as e:
    print (e)
    print ('')
    usage()
    sys.exit(2)

try:
    destfile = '/etc/opt/microsoft/mdatp/mdatp_onboard.json'

    if os.geteuid() != 0:
        print('Re-running as sudo (you may be required to enter sudo''s password)')
        os.execvp('sudo', ['sudo', 'python'] + sys.argv)  # final version

    print('Generating %s ...' % destfile)

    cmd = "sudo mkdir -p '%s'" % (os.path.dirname(destfile))
    subprocess.check_call(cmd, shell = True)

    with open(destfile, "w") as json:
        json.write('''{
  "onboardingInfo": "{\\\"body\\\":\\\"{\\\\\\\"previousOrgIds\\\\\\\":[\\\\\\\"00000001-0000-4000-8000-000000000001\\\\\\\"],\\\\\\\"orgId\\\\\\\":\\\\\\\"00000002-0000-4000-8000-000000000002\\\\\\\",\\\\\\\"geoLocationUrl\\\\\\\":\\\\\\\"https://winatp-gw-usmt.microsoft.com/\\\\\\\",\\\\\\\"datacenter\\\\\\\":\\\\\\\"UsModTexas\\\\\\\",\\\\\\\"vortexGeoLocation\\\\\\\":\\\\\\\"FFL4\\\\\\\",\\\\\\\"vortexServerUrl\\\\\\\":\\\\\\\"https://us4-v20.events.data.microsoft.com/OneCollector/1.0\\\\\\\",\\\\\\\"vortexTicketUrl\\\\\\\":\\\\\\\"https://events.data.microsoft.com\\\\\\\",\\\\\\\"vortexRoutingHint\\\\\\\":\\\\\\\"2752e9ba12f6440e9a4e829e4ca4ab96-7323bb77-9098-4342-84c0-8400bf34a851-7343\\\\\\\",\\\\\\\"partnerGeoLocation\\\\\\\":\\\\\\\"FFL4Mod\\\\\\\",\\\\\\\"version\\\\\\\":\\\\\\\"2.01\\\\\\\",\\\\\\\"deviceType\\\\\\\":\\\\\\\"Server\\\\\\\",\\\\\\\"packageGuid\\\\\\\":\\\\\\\"00000004-0000-4000-8000-000000000004\\\\\\\"}\\\",\\\"sig\\\":\\\"MATDu0RActrjgNso8FiqUCDwQArLSXNAzCGmZZYRWuaAbr/z3L1St6XMw+GH36/3mLO50Ah1IrCWkMo0sYOMRVzpwbInJI2+GE5vSoD+H9yjlmypgGs6+Rl65xXlDdqWG9gFEf8REX9fDXRyjfc77mZLYw9yy6UHJh5ndPdtnUkXzStnG4jPIG+Ixfxw7HVfLo39WJ4iEEd4RVhNnnJdfdP6T3qHoEG8PUh39K0+4Gpqbs1FBNksRD9owzuUoYmg/09ONehFPd9hG7yyLwkidSqP4a6phcI8X60m+h1QnRiq3uDQOG818VhfZlzV8/Py4anrx7co9/QsCsfk+3L4ag==\\\",\\\"sha256sig\\\":\\\"MATDu0RActrjgNso8FiqUCDwQArLSXNAzCGmZZYRWuaAbr/z3L1St6XMw+GH36/3mLO50Ah1IrCWkMo0sYOMRVzpwbInJI2+GE5vSoD+H9yjlmypgGs6+Rl65xXlDdqWG9gFEf8REX9fDXRyjfc77mZLYw9yy6UHJh5ndPdtnUkXzStnG4jPIG+Ixfxw7HVfLo39WJ4iEEd4RVhNnnJdfdP6T3qHoEG8PUh39K0+4Gpqbs1FBNksRD9owzuUoYmg/09ONehFPd9hG7yyLwkidSqP4a6phcI8X60m+h1QnRiq3uDQOG818VhfZlzV8/Py4anrx7co9/QsCsfk+3L4ag==\\\",\\\"cert\\\":\\\"MIIFuTCCA6GgAwIBAgITMwAAA1W9fcTxQTZ8bQAAAAADVTANBgkqhkiG9w0BAQsFADB+MQswCQYDVQQGEwJVUzETMBEGA1UECBMKV2FzaGluZ3RvbjEQMA4GA1UEBxMHUmVkbW9uZDEeMBwGA1UEChMVTWljcm9zb2Z0IENvcnBvcmF0aW9uMSgwJgYDVQQDEx9NaWNyb3NvZnQgU2VjdXJlIFNlcnZlciBDQSAyMDExMB4XDTI1MDEwNzE4MjY0MVoXDTI2MDEwNzE4MjY0MVowOTE3MDUGA1UEAxMuQ2xvdWRDbGllbnRBdXRoZW50aWNhdGlvbi1GTS51c2dvdmNsb3VkYXBwLm5ldDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAMB3zWdrmANrL8lcSfT7aBjo7cXtmPqQr9mgNJSMNiqAofm83UaXxsemb7qcXvKmOBeRnAAfUFjPqIMj3fH69J3j8B31gH3Wm9a5BHYSgJAJsw3JKsnQuYY4S11BAsBWRpkReblEmGUKe48ZwaX1vZdcbjeSwzQ6GjGje2I6QQa5cQQfAbTyoXu8Bal3voHXu3r/vl9VNo5SPipW+pH5bNSfZKMfFFadgo6Pr4z5mCfmZ2nD0gKsRjjUfiX6bJHeWNny2Otd6pxcBxO9po9XAxmyBBW2gK4NNjlCtqjVYnZ9n5kO8nDjXfWGrm8qKrH8KldcwpmGqSrBiMkxMGSt8AECAwEAAaOCAXMwggFvMA4GA1UdDwEB/wQEAwIFIDAdBgNVHSUEFjAUBggrBgEFBQcDAQYIKwYBBQUHAwIwDAYDVR0TAQH/BAIwADA5BgNVHREEMjAwgi5DbG91ZENsaWVudEF1dGhlbnRpY2F0aW9uLUZNLnVzZ292Y2xvdWRhcHAubmV0MB0GA1UdDgQWBBSyW4yNCcn4GlZ5MqL/seKzEE647TAfBgNVHSMEGDAWgBQ2VollSctbmy88rEIWUE2RuTPXkTBTBgNVHR8ETDBKMEigRqBEhkJodHRwOi8vd3d3Lm1pY3Jvc29mdC5jb20vcGtpb3BzL2NybC9NaWNTZWNTZXJDQTIwMTFfMjAxMS0xMC0xOC5jcmwwYAYIKwYBBQUHAQEEVDBSMFAGCCsGAQUFBzAChkRodHRwOi8vd3d3Lm1pY3Jvc29mdC5jb20vcGtpb3BzL2NlcnRzL01pY1NlY1NlckNBMjAxMV8yMDExLTEwLTE4LmNydDANBgkqhkiG9w0BAQsFAAOCAgEAaf9C/86OQKc8RVLl7aVOZiDXpyikCAWkmc/9WupzjPlTSLFzs0W8UWokr24l9RFIMrPuDmjDDzMO+SapETmTKdR6lE8iDsetGpR97hq+a3ZYNh+ZubP0leig9nl6GNReV5c/4Ow4R93Xs6Xg5NSiaM1/9ckebFIvqfuRclArRV/qoY9CoRLhSQ81fZUUUaB6Qa6pJ8X6S35V5/54DmlAWcyXMfvpw7LvKU/fYRqh7I1KWZyZUnZIJ3JtVDR38WbysAKEdZKvQ3VQ0j9M9kI2z5BNIUcVMih8bCyiSjovhv/aLuB+lan1OP1fqrZ4DZnQr2JJxFhaUvSb+xAjeNy/D3PLPkrzGHsfvMOJwr6OSwerrbzHnh2UYnM4Aw5WlgxTAsr8VxNDzvzaGvbGIWEqljP4wCDHsZhnar7hBY/awgp1lWq5LdSs8N+PjiOxIyJuAw3vqsdrf3Hiwg89Hf/A6Bp+4KEgXiplztdMgwI1yIK5Z5UcmuDDYaklWcjxSCU/rI89TCAHoSGZmD/qMx1qitVNNvJ4IDadkFm4mtYY673C7UcZgkF8f/vW8uvvks8yjOAIJNf9tGGx6AI1awbQXKBviGajS27v7JjHxzUWl4x0uHIwzaCc4XLeD5gjAGz6iYPjGMiNaKY03yIfFeQLzx3Phvu5YBV7+illsUNj30Y=\\\",\\\"chain\\\":[\\\"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\\\"]}"
}''')

    cmd = "logger -p warning Microsoft ATP: succeeded to save json file %s." % (destfile)
    subprocess.check_call(cmd, shell = True)

except Exception as e:
    print(str(e))
    cmd = "logger -p error Microsoft ATP: failed to save json file %s. Exception occured: %s. " % (destfile, str(e))
    subprocess.call(cmd, shell = True)
    sys.exit(1)