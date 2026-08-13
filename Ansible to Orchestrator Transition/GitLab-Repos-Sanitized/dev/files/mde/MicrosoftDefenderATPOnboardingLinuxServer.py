#!/usr/bin/env python

import sys, getopt, os, errno, json, syslog, tempfile

def usage():
    print ("""Usage: %s
    Performs onboarding or offboarding to WDATP locally
""" % sys.argv[0])
    pass

def create_dir(directory_path):
    if not os.path.exists(directory_path):
        os.makedirs(directory_path) 

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

    create_dir(os.path.dirname(destfile))

    with open(destfile, "w") as json_file:
        json_file.write('''{
  "onboardingInfo": "{\\\"body\\\":\\\"{\\\\\\\"previousOrgIds\\\\\\\":[\\\\\\\"00000001-0000-4000-8000-000000000001\\\\\\\"],\\\\\\\"orgId\\\\\\\":\\\\\\\"00000002-0000-4000-8000-000000000002\\\\\\\",\\\\\\\"geoLocationUrl\\\\\\\":\\\\\\\"https://winatp-gw-usmt.microsoft.com/\\\\\\\",\\\\\\\"datacenter\\\\\\\":\\\\\\\"UsModTexas\\\\\\\",\\\\\\\"vortexGeoLocation\\\\\\\":\\\\\\\"FFL4\\\\\\\",\\\\\\\"vortexServerUrl\\\\\\\":\\\\\\\"https://us4-v20.events.data.microsoft.com/OneCollector/1.0\\\\\\\",\\\\\\\"vortexTicketUrl\\\\\\\":\\\\\\\"https://events.data.microsoft.com\\\\\\\",\\\\\\\"vortexRoutingHint\\\\\\\":\\\\\\\"2752e9ba12f6440e9a4e829e4ca4ab96-7323bb77-9098-4342-84c0-8400bf34a851-7343\\\\\\\",\\\\\\\"partnerGeoLocation\\\\\\\":\\\\\\\"FFL4Mod\\\\\\\",\\\\\\\"version\\\\\\\":\\\\\\\"2.11\\\\\\\",\\\\\\\"deviceType\\\\\\\":\\\\\\\"Server\\\\\\\",\\\\\\\"packageGuid\\\\\\\":\\\\\\\"00000003-0000-4000-8000-000000000003\\\\\\\"}\\\",\\\"sig\\\":\\\"bmE0iX0j6cuBLrLgDQ5wnozj7sYLHpcWbF1M8rGxzZsCHDXDzqwUNlrOxw8LnxoPl05JSIVNekGnZ5pQqTIPZ5AvzhXXGyNYPqUIeA0o7JSPUEIhITSlWNEMNI3r/Mg4Pyas3lBLZK3hW90UQiLmxG5jzn7qeAOihCdeWbN91hI64ZjvMG2cD58b9vzuuNH8vzhSCgMOun/TMAE1WwYjym7VwpZRB5W4JIDA5Tw+E9309NtywjVy28IgDZ7SaQIqHatj1WxCq0xauMPaTJZlfbB0+YJsF5w/dmPrE+7jBtz5I7XfInaMo8JkofV0gjfDZkAnb9Y7sQafCJ3e7vn/Sg==\\\",\\\"sha256sig\\\":\\\"bmE0iX0j6cuBLrLgDQ5wnozj7sYLHpcWbF1M8rGxzZsCHDXDzqwUNlrOxw8LnxoPl05JSIVNekGnZ5pQqTIPZ5AvzhXXGyNYPqUIeA0o7JSPUEIhITSlWNEMNI3r/Mg4Pyas3lBLZK3hW90UQiLmxG5jzn7qeAOihCdeWbN91hI64ZjvMG2cD58b9vzuuNH8vzhSCgMOun/TMAE1WwYjym7VwpZRB5W4JIDA5Tw+E9309NtywjVy28IgDZ7SaQIqHatj1WxCq0xauMPaTJZlfbB0+YJsF5w/dmPrE+7jBtz5I7XfInaMo8JkofV0gjfDZkAnb9Y7sQafCJ3e7vn/Sg==\\\",\\\"cert\\\":\\\"MIIFwjCCA6qgAwIBAgITMwAABCFOrww6nK14OgAAAAAEITANBgkqhkiG9w0BAQsFADB+MQswCQYDVQQGEwJVUzETMBEGA1UECBMKV2FzaGluZ3RvbjEQMA4GA1UEBxMHUmVkbW9uZDEeMBwGA1UEChMVTWljcm9zb2Z0IENvcnBvcmF0aW9uMSgwJgYDVQQDEx9NaWNyb3NvZnQgU2VjdXJlIFNlcnZlciBDQSAyMDExMB4XDTI1MTIxMTE5MTkxMFoXDTI2MTAwMzE5MTkxMFowQjFAMD4GA1UEAxM3bTM2NWRvb3AtQ2xvdWRDbGllbnRBdXRoZW50aWNhdGlvbi1GTS51c2dvdmNsb3VkYXBwLm5ldDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAMNWseIc5bDU+UnknUKWwNE/ujGLL8fLbtNdPsUqU0Tdgql/hnT2KzDBjZCAs8ZSDgSSsQwrdcggonLfSYP3bYXDJU2+clObQ5R6eA7lPeRdaK7C/qJTN3gGd4FTbQz7b64eUUow8rREAoKysmz1Ef4tOA0V2xrBT3iadjc0FEpBLXnt0/DsFajIEM2Ps8yiQrVdsbMSWLVP/faqEGVsu8b0e73guBPvgYfpOsRKzam9mLNUY71+CHAd5kWtCYOSFx2ZsDwKENhSsl1SkW6EXnSJg3H06EEwT424yLewOfEag8Lnd6POhuqhVVbLlXUuOE0FS2/Y/M31Oi6O0vgtt8ECAwEAAaOCAXMwggFvMA4GA1UdDwEB/wQEAwIFIDAdBgNVHSUEFjAUBggrBgEFBQcDAQYIKwYBBQUHAwIwDAYDVR0TAQH/BAIwADA5BgNVHREEMjAwgi5DbG91ZENsaWVudEF1dGhlbnRpY2F0aW9uLUZNLnVzZ292Y2xvdWRhcHAubmV0MB0GA1UdDgQWBBS/4xxirpdwh94zJpIrrkwA3zxSrTAfBgNVHSMEGDAWgBQ2VollSctbmy88rEIWUE2RuTPXkTBTBgNVHR8ETDBKMEigRqBEhkJodHRwOi8vd3d3Lm1pY3Jvc29mdC5jb20vcGtpb3BzL2NybC9NaWNTZWNTZXJDQTIwMTFfMjAxMS0xMC0xOC5jcmwwYAYIKwYBBQUHAQEEVDBSMFAGCCsGAQUFBzAChkRodHRwOi8vd3d3Lm1pY3Jvc29mdC5jb20vcGtpb3BzL2NlcnRzL01pY1NlY1NlckNBMjAxMV8yMDExLTEwLTE4LmNydDANBgkqhkiG9w0BAQsFAAOCAgEAtATGBL+CCCzuUjaJJZ9IEO1T3QpRZuBQIbaZRfhs8oCnT2pVhuTDgMI36etQy6O/0UY6B4cpP7hOhgLaq7Vr/A4fqY8FUyqt9HMY0kJhpoGyAdBzZtCI0iHtNjSB/XEwzErXRmdCx326Cc+IJv14BFiCLvNLuu3DTCeppP7VmcSndwyRIwE+WeXjeC9i7s2eC5eIi3KxN8Qmh4OzspGhG4bUDICuIAcp7h4DpEn2OPhVV8TQDBmk5pV6B3QzhYGMpWZSGhFCQTb8k9/Wijlg1flPb8/D5ZT24zL9JLFkhvmYzkxcgAmlHGOaKITK33LVpaLb6l8w1GywNoAEor/auvB3Akh4kFZdfyFXUuvcBKFGwcdJk+JsTke8VkA7MOeUXSVVAgrBxznAVZJhGlOf+oGGOgsqC3gXMGjzV6tnUXeDQPmvmvCiJlUXuFJHEX7M/nSfUHGSpSyyTRT8tM/fXJByt7IB3EWjVnWJVoaamV2aoIp39WtOnNRpELi9QzW/c11z7d0eBw/nuVMnSE2iTQx5snoK408nQm08/h+Som8KN3xSRRvN/M3MCavxsdMqrLoJKVpkZlyziU1zIyGOZJyez0sAaLRBm4uwFZb3e33Iw4/FRoQ2VN5+9XUbxj5H6BoIb8or/VxMoeqGB88hpJzhLxKvTGcCsJpHc++OcEA=\\\",\\\"chain\\\":[\\\"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\\\"]}"
}''')

    os.chmod(destfile, 0o640)

    syslog.syslog(syslog.LOG_WARNING, "Microsoft ATP: succeeded to save json file %s." % (destfile))

except Exception as e:
    print(str(e))
    syslog.syslog(syslog.LOG_ERR, "Microsoft ATP: failed to save json file %s. Exception occured: %s." % (destfile, str(e)))
    sys.exit(1)