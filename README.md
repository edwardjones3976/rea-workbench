# REA Workbench

A Windows desktop pilot for turning saved behavior evidence into an original TypeScript tool. Use Extraction Mode to review evidence-linked rules, Tool Creator to generate and test a tool, and Recipes to combine approved tools and inspect their results.

**[Read the operator manual](docs/manual.html)** · **[Download the offline HTML manual](https://raw.githubusercontent.com/edwardjones3976/rea-workbench/main/docs/manual.html)**

Open the downloaded HTML file in a browser for the quick start, a full walkthrough, setup commands, and troubleshooting.

## Run the pilot

Desktop execution requires Windows, Python, Node 26, Docker Desktop, REA Agents 6.10.1, and access to the compatible Desk Code checkout described in the manual. This repository contains the Workbench source and its Desk Code pilot patch. The Desk Code base is distributed separately. The pilot is built from source.

From a configured checkout, ask your Desk Code-enabled assistant to launch the REA Workbench demo. Select **Create sample project** to try the workflow with a deterministic local fixture. The demo requires no provider key.

## What’s included

- A sandboxed Electron UI and authenticated loopback connection to the pilot supervisor.
- Evidence import, rule-by-rule review, human approval, and TypeScript tool generation.
- Docker-contained generated execution, a local plugin and MCP fixture, and portable project bundles.
- A deterministic end-to-end self-test and hidden Electron smoke tests.

The Workbench code is [MIT licensed](LICENSE). The optional [REA result helper](vendor/catalog.json) retains its upstream license and provenance.
