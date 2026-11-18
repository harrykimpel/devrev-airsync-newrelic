# New Relic branding in DevRev

The official [green emblem PNG](../assets/newrelic/new-relic-emblem-green.png)
and [SVG](../assets/newrelic/new-relic-emblem-green.svg) are included for use as
integration/listing artwork. The files are unchanged from New Relic's
[media assets](https://newrelic.com/about/media-assets); their provenance and
trademark terms are recorded in [the asset README](../assets/newrelic/README.md).

## Snap-in icon

DevRev marketplace listings carry an **icon artifact**. This is listing metadata,
separate from the snap-in version's `manifest.yaml`. The supported public
[listing workflow](https://developer.devrev.ai/snapin-development/marketplace-listings)
starts with:

```bash
devrev marketplace_submissions create \
  --org harry-kimpel-testing \
  --usr harry.kimpel@devrev.ai
```

Use the existing connector package/version when preparing the submission and
choose the official emblem as its listing icon. The exact artifact upload/input
steps depend on the installed CLI's wizard and the publisher permissions granted
to your org. If the wizard asks for an artifact ID instead of a local file, the
image must first be uploaded as a DevRev marketplace-listing-icon artifact; a
local pathname or public image URL is not an artifact DON.

If a listing already exists, create a new submission for that listing rather
than a second listing. Listing creation, review and publication are separate
operations. DevRev also documents restricted listings for sharing with selected
organizations; a listing does not have to be made publicly installable merely
to prepare branding. Confirm the intended access level before publishing.

This repository change only prepares assets and instructions. It does not
create, submit, publish or install a marketplace item in your org.

## AirSync icon

DevRev's external-system capability metadata has an `icon_artifact` and can
identify a `marketplace_item_slug`. The CLI's AirSync import definition does
not expose an independent logo URL/path, and the public manifest reference
does not document a logo field under `imports`.

Use the branded listing as the starting point, then verify the actual icon on
the New Relic AirSync entry as well as the snap-in. The available public docs
do not establish that updating a listing automatically updates every existing
AirSync icon. If it remains generic, ask DevRev to confirm the icon-artifact
association for the external import slug `airdrop-newrelic-snap-in` and the
associated marketplace item. That association cannot be verified or changed
from this repository alone.

## Existing direct CLI installation

`npm run deploy` creates a package/version and installs a draft directly. It
does not create a marketplace listing or upload a listing icon. The public
manifest format and CLI v0.4.16 commands inspected for this connector provide
no verified switch for changing that installation's generic icon.

Adding these images to the repository, putting `logo:`/`icon:` in the manifest,
or running another deployment is not a supported way to apply the listing icon.
Do not delete or reinstall a working snap-in/AirSync just to change its artwork.
Before attempting to replace the installation through a listing, confirm with
DevRev how it will preserve the current AirSync and installation bindings.

If you only want to brand the current private installation, ask DevRev whether
they support setting its marketplace-item details/icon or the corresponding
AirSync capability icon without publishing/reinstalling. This remains a
platform configuration step, not a connector code setting.

## References

- [DevRev manifest specification](https://developer.devrev.ai/snapin-development/references/manifest)
- [AirSync manifest](https://developer.devrev.ai/airsync/manifest)
- [Marketplace listings](https://developer.devrev.ai/snapin-development/marketplace-listings)
- [AirSync publication workflow](https://developer.devrev.ai/airsync/publish-to-marketplace)
- Verified locally against CLI v0.4.16 help and its generated model metadata:
  `InitialSubmission`/`MarketplaceSubmission` have `IconArtifact`;
  `SnapInImport` and `SnapInPackage` do not expose an icon setter. The installed
  TypeScript SDK 1.1.78 beta `ExternalSystemCapabilities` exposes `icon_artifact`.
