using System.Security.Cryptography;
using System.Security.Cryptography.Pkcs;
using System.Security.Cryptography.X509Certificates;

namespace PdfAndMoore.Services;

/// <summary>A digital ID as shown in the "Sign with a digital ID" list.</summary>
public sealed record DigitalIdInfo(string Thumbprint, string Name, string Email, string Issuer, string Expires, bool SelfSigned);

/// <summary>
/// Digital IDs (certificates with a private key) for signing PDFs.
/// They live in the Windows certificate store ("Personal" for the current user), so IDs from a
/// company, a certificate authority or a smart card also show up and work here.
/// </summary>
public static class DigitalIdService
{
    private const string DocumentSigningOid = "1.3.6.1.4.1.311.10.3.12";
    private const string EmailProtectionOid = "1.3.6.1.5.5.7.3.4";
    private const string Sha256Oid = "2.16.840.1.101.3.4.2.1";

    private static X509Store OpenStore(OpenFlags flags)
    {
        var store = new X509Store(StoreName.My, StoreLocation.CurrentUser);
        store.Open(flags);
        return store;
    }

    public static DigitalIdInfo Describe(X509Certificate2 c) => new(
        c.Thumbprint,
        c.GetNameInfo(X509NameType.SimpleName, false),
        c.GetNameInfo(X509NameType.EmailName, false),
        c.GetNameInfo(X509NameType.SimpleName, true),
        c.NotAfter.ToString("o"),
        c.SubjectName.RawData.AsSpan().SequenceEqual(c.IssuerName.RawData));

    /// <summary>IDs that can sign: have a private key, are not expired, and allow signing.</summary>
    public static List<DigitalIdInfo> List()
    {
        using var store = OpenStore(OpenFlags.ReadOnly | OpenFlags.OpenExistingOnly);
        var list = new List<DigitalIdInfo>();
        foreach (X509Certificate2 c in store.Certificates)
        {
            if (!c.HasPrivateKey || c.NotAfter < DateTime.Now || c.NotBefore > DateTime.Now) continue;
            var usage = c.Extensions.OfType<X509KeyUsageExtension>().FirstOrDefault();
            if (usage != null && (usage.KeyUsages & (X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.NonRepudiation)) == 0) continue;
            var eku = c.Extensions.OfType<X509EnhancedKeyUsageExtension>().FirstOrDefault();
            if (eku != null)
            {
                // Skip certificates made only for websites or code (e.g. developer HTTPS certificates).
                var oids = eku.EnhancedKeyUsages.Cast<Oid>().Select(o => o.Value).ToList();
                bool forDocs = oids.Contains(DocumentSigningOid) || oids.Contains(EmailProtectionOid) || oids.Contains("2.5.29.37.0") || oids.Contains("1.2.840.113583.1.1.5");
                if (!forDocs) continue;
            }
            list.Add(Describe(c));
        }
        return list.OrderBy(i => i.Name).ToList();
    }

    /// <summary>Make a self-signed digital ID (like Acrobat's) and keep it in the Windows certificate store.</summary>
    public static DigitalIdInfo Create(string name, string? email, string? org)
    {
        if (string.IsNullOrWhiteSpace(name)) throw new ArgumentException("Enter your name.");
        var dn = new X500DistinguishedNameBuilder();
        dn.AddCommonName(name.Trim());
        if (!string.IsNullOrWhiteSpace(org)) dn.AddOrganizationName(org.Trim());
        if (!string.IsNullOrWhiteSpace(email)) dn.AddEmailAddress(email.Trim());

        using RSA rsa = RSA.Create(3072);
        var req = new CertificateRequest(dn.Build(), rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        req.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        req.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.NonRepudiation, true));
        req.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(new OidCollection { new Oid(DocumentSigningOid), new Oid(EmailProtectionOid) }, false));
        req.CertificateExtensions.Add(new X509SubjectKeyIdentifierExtension(req.PublicKey, false));
        if (!string.IsNullOrWhiteSpace(email))
        {
            var san = new SubjectAlternativeNameBuilder();
            san.AddEmailAddress(email.Trim());
            req.CertificateExtensions.Add(san.Build());
        }

        using X509Certificate2 temp = req.CreateSelfSigned(DateTimeOffset.Now.AddMinutes(-5), DateTimeOffset.Now.AddYears(5));
        // Re-import so the private key is saved with the certificate (and can be backed up).
        string pw = Convert.ToBase64String(RandomNumberGenerator.GetBytes(24));
        var persisted = new X509Certificate2(temp.Export(X509ContentType.Pfx, pw), pw,
            X509KeyStorageFlags.UserKeySet | X509KeyStorageFlags.PersistKeySet | X509KeyStorageFlags.Exportable);
        if (OperatingSystem.IsWindows()) persisted.FriendlyName = "PDF and Moore digital ID - " + name.Trim();
        using var store = OpenStore(OpenFlags.ReadWrite);
        store.Add(persisted);
        return Describe(persisted);
    }

    /// <summary>Add a .pfx / .p12 digital ID file to the Windows certificate store.</summary>
    public static DigitalIdInfo Import(string path, string password)
    {
        X509Certificate2 cert;
        try
        {
            cert = new X509Certificate2(path, password,
                X509KeyStorageFlags.UserKeySet | X509KeyStorageFlags.PersistKeySet | X509KeyStorageFlags.Exportable);
        }
        catch (CryptographicException)
        {
            throw new InvalidOperationException("The password is wrong, or this isn't a digital ID file.");
        }
        if (!cert.HasPrivateKey) throw new InvalidOperationException("This file has a certificate but no private key, so it can't be used to sign.");
        using var store = OpenStore(OpenFlags.ReadWrite);
        store.Add(cert);
        return Describe(cert);
    }

    private static X509Certificate2 Find(string thumbprint)
    {
        using var store = OpenStore(OpenFlags.ReadOnly | OpenFlags.OpenExistingOnly);
        var found = store.Certificates.Find(X509FindType.FindByThumbprint, thumbprint, false);
        if (found.Count == 0) throw new InvalidOperationException("That digital ID is no longer on this computer.");
        return found[0];
    }

    /// <summary>Backup copy of an ID (with its private key), protected by a password.</summary>
    public static byte[] Export(string thumbprint, string password)
    {
        if (string.IsNullOrEmpty(password) || password.Length < 4) throw new ArgumentException("Use a password of at least 4 characters.");
        using X509Certificate2 c = Find(thumbprint);
        try
        {
            return c.Export(X509ContentType.Pfx, password);
        }
        catch (CryptographicException)
        {
            throw new InvalidOperationException("This ID can't be copied (its key is protected, for example on a smart card).");
        }
    }

    /// <summary>A detached CMS (PKCS #7) signature over the given bytes, as PDF signatures use.</summary>
    public static byte[] Sign(string thumbprint, byte[] data)
    {
        using X509Certificate2 cert = Find(thumbprint);
        if (!cert.HasPrivateKey) throw new InvalidOperationException("This digital ID has no private key.");
        var cms = new SignedCms(new ContentInfo(data), detached: true);
        var signer = new CmsSigner(SubjectIdentifierType.IssuerAndSerialNumber, cert)
        {
            DigestAlgorithm = new Oid(Sha256Oid),
            IncludeOption = X509IncludeOption.WholeChain,
        };
        signer.SignedAttributes.Add(new Pkcs9SigningTime(DateTime.UtcNow));
        // silent: false lets Windows ask for a smart-card PIN if the ID needs one.
        cms.ComputeSignature(signer, silent: false);
        return cms.Encode();
    }
}
