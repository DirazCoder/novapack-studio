# Creating NovaByte Studio templates

Studio starter templates are JSON bundles. A bundle contains a manifest and
project files; Studio previews those files as text and does not execute them
while importing, downloading, or previewing a template.

## Create and export a local template

1. Open a project in Studio and save all changes.
2. Open **New Project** and choose **Save open project as starter**.
3. Give the starter a name. Studio stores the template locally in its settings.
4. Select the starter and choose **Export selected** to save a `.nbtemplate`
   file.
5. To use it on another Studio installation, choose **Import .nbtemplate** in
   **New Project**. Existing `.json` starter files can also be imported.

The `.nbtemplate` extension is a convenient label for a JSON file, not a trust
or security marker. Locally saved and imported templates are unverified.

## Bundle format

A `.nbtemplate` is UTF-8 JSON with this shape:

```json
{
  "format": "novapack-studio-user-template",
  "version": 1,
  "template": {
    "name": "Hello Starter",
    "description": "A small web app starter project.",
    "author": "Example Publisher",
    "releaseVersion": "1.0.0",
    "category": "web",
    "icon": "box",
    "manifest": {
      "id": "com.example.hello",
      "name": "Hello Starter",
      "version": "1.0.0",
      "description": "A small web app starter project.",
      "author": "Example Publisher",
      "entry": "index.html",
      "icon": "box",
      "type": "blank",
      "permissions": [],
      "permissionReasons": {}
    },
    "files": {
      "index.html": "PCFkb2N0eXBlIGh0bWw+CjxodG1sIGxhbmc9ImVuIj4KPGhlYWQ+CiAgPG1ldGEgY2hhcnNldD0idXRmLTgiPgogIDxtZXRhIG5hbWU9InZpZXdwb3J0IiBjb250ZW50PSJ3aWR0aD1kZXZpY2Utd2lkdGgsIGluaXRpYWwtc2NhbGU9MSI+CiAgPHRpdGxlPkhlbGxvIFN0YXJ0ZXI8L3RpdGxlPgo8L2hlYWQ+Cjxib2R5PgogIDxtYWluPjxoMT5IZWxsbyBmcm9tIFN0dWRpbyE8L2gxPjwvbWFpbj4KPC9ib2R5Pgo8L2h0bWw+Cg=="
    }
  }
}
```

The example's Base64 `index.html` decodes to a complete, minimal HTML page.
Each `files` value is the file's bytes encoded as standard Base64. File paths
are project-relative and use `/` separators. The manifest is stored separately
in `template.manifest`; do not include `manifest.json` or `novaapp.json` in
`template.files`.

The manifest is the app manifest that Studio writes into the generated
project:

- `entry` is required. Its path must match one of the keys in `template.files`;
  Studio and the app builder use it to find the app's starting document.
- `permissions` lists capabilities the app requests. Use `[]` when the example
  app needs no special permissions; only add valid permissions that its code
  actually needs. `permissionReasons` can explain declared permissions and is
  `{}` in this example because there are none.
- `id`, `name`, and `version` are starter defaults. Studio replaces them with
  the values entered when the user creates a project. Other manifest fields
  remain as supplied.

When a project is created, Studio writes the files and updates the manifest's
app ID, name, and version using the values entered in the New Project window.
The bundle's manifest provides the remaining defaults.

## Limits and file rules

Studio validates local and community templates before saving or creating a
project:

- Bundle JSON: at most 4 MiB.
- Expanded project files: at most 2 MiB total and 1,000 files.
- Manifest JSON: at most 256 KiB.
- Name: 1–80 characters; description: at most 240 characters (community
  publishing requires 10–240 characters).
- Author: at most 80 characters; category: at most 40 characters; icon: at
  most 100 characters.
- `releaseVersion` must be a semantic version, such as `1.0.0`.
- Paths must be relative and cannot contain traversal, hidden path segments,
  `node_modules`, Windows separators, or reserved manifest filenames.

Studio uses `category` in the starter gallery: recognized values such as `web`,
`native`, `api`, and `apps` appear in their matching built-in sections. Other
category values create their own gallery section, and the category is shown on
the template card.

For community publishing, the Store accepts text files only, limits templates
to 500 files and 2 MiB of expanded UTF-8 text, and does not accept screenshots,
binary assets, hidden files, or `node_modules`. Studio's exported Base64 file
contents are converted to UTF-8 text by the Publisher Portal; non-text files
are rejected.

## Publish a community template

1. Export the starter as `.nbtemplate` from Studio.
2. Sign in to the NovaByte Publisher Portal and choose **Submit community
   template**.
3. Enter a permanent template ID, such as `com.example.hello`, and select the
   `.nbtemplate` export.
4. Review the submitted template details and wait for the NovaByte review.
5. The reviewer inspects the JSON and its files, uploads the exact reviewed
   version, and approves or requests changes.

For later releases, submit an update using the same template ID and a
`releaseVersion` newer than the currently published version.

Community templates are not listed until they pass human review. On approval,
the Store signs the bundle with NovaByte's trusted Ed25519 signing key. Studio
shows **Verified** only after checking that signature and confirming the
signed metadata matches the catalog. Signing verifies the publisher and
integrity; it does not guarantee that project code is safe to run. Inspect
template contents before running the generated project.
