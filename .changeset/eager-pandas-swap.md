---
"@deadlock-mods/desktop": minor
---

Add support for config mods that replace the game's gameinfo.gi

Enabling one backs up your current game configuration first, and disabling it restores that backup. Only one can be applied at a time, so applying a new config mod automatically disables the previous one. Mods that ship several configurations get a version picker under Manage Files, where any file containing no gameinfo.gi is shown greyed out with the reason it cannot be used.

A mod that ships a gameinfo.gi alongside VPK files applies both, since an author who bundles the two means them to work together. The applied configuration is shared by every profile rather than belonging to the one you enabled it from — there is only one game configuration file to replace.
