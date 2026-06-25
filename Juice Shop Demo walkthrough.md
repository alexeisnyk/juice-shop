# Juice Shop on Kubernetes + Snyk: Demo Walkthrough

A demo for deploying Snyk's custom fork of OWASP Juice Shop and scanning it with Snyk four ways: **source code (Snyk Code / SAST via the SCM integration)**, **container image**, **IaC manifests**, and **monitoring in the Snyk UI**.

**Files in this bundle** (in `k8s-src/`)

- `juice-shop-deploy.yaml` — the Deployment (`snyk-juice-shop`, image `clintonherget/snyk-juice-shop`, `privileged: true` — intentionally insecure so the IaC scan finds real issues)
- `juice-shop-service.yaml` — the Service (ClusterIP, `8080 → 3000`)
- `juice-shop-deploy-hardened.yaml` — the same Deployment with fixes applied, for the "before / after" moment

**Total demo time:** ~10 min. **Prereqs:** Docker Desktop with Kubernetes (kind) enabled, `kubectl`, and the Snyk CLI authenticated.

> **Environment note:** These manifests deploy into the **`default`** namespace (no namespace is set), the Deployment is named **`snyk-juice-shop`**, and the Service is **ClusterIP** — so we reach the app with `kubectl port-forward`, not a NodePort.

---

## 0. Pre-Demo Setup

```shell
# Install the tools
brew install snyk-cli kubectl

# Authenticate the Snyk CLI
snyk auth

# Confirm your Kubernetes cluster from Docker Desktop is in context
kubectl config use-context docker-desktop
kubectl get nodes
```

Expected:

```
NAME                     STATUS   ROLES           AGE   VERSION
desktop-control-plane    Ready    control-plane   1m    v1.34.3
```

**Pull the image into your local Docker daemon.** `snyk container test` reads from Docker, not from kind's internal containerd — so even though the pod is running, you must pull the image locally for the scan to find it. The fork image is **amd64-only** (last built 2022), so pull it explicitly for your M-series Mac; it runs under emulation, which is fine for a demo:

```shell
docker pull --platform linux/amd64 clintonherget/snyk-juice-shop:latest
```

> Why the prebuilt image and not a local build? Snyk's fork Dockerfile targets Node 12, which is deprecated and won't build in current Docker — so we deploy and scan the prebuilt `clintonherget/snyk-juice-shop` image from Docker Hub instead.

---

## 1. Deploy Juice Shop

Apply both manifests in `k8s-src/` at once:

```shell
kubectl apply -f k8s-src/
```

Expected:

```
deployment.apps/snyk-juice-shop created
service/snyk-juice-shop created
```

Wait for the pod to be ready:

```shell
kubectl rollout status deployment/snyk-juice-shop
kubectl get pods -l app=snyk-juice-shop
```

The Service is ClusterIP, so reach the app with port-forward:

```shell
# Forward localhost:3000 straight to the pod
kubectl port-forward deployment/snyk-juice-shop 3000:3000
open http://localhost:3000

# (Alternative, via the Service's 8080 port)
# kubectl port-forward svc/snyk-juice-shop 3000:8080
```

You should see the Juice Shop landing page. **Talking point:** a deliberately vulnerable app — perfect for showing Snyk's capabilities.

---

## 2. Scan the source code with Snyk Code (SCM integration)

This is the namesake of the demo: Snyk's **SCM integration** connects the GitHub repo to Snyk (via the Snyk GitHub App), and **Snyk Code (SAST)** scans the application source for vulnerabilities — independent of the image or the cluster. You can run it locally with the CLI, but the headline beat is the **pull-request flow** in the Snyk UI.

### Option A — run the SAST scan locally

```shell
snyk code test
```

Findings to point out (all live in `routes/`):

| Finding | File | Why it matters |
| :---- | :---- | :---- |
| **SQL Injection** | [routes/login.js](routes/login.js#L30) | User-controlled `req.body.email` is concatenated straight into a raw SQL query — the classic Juice Shop login bypass (`' OR 1=1--`). The headline SAST finding. |
| Directory traversal / Zip Slip | `routes/fileUpload.js` | Zip entry paths written without normalization (now **remediated** — see below). |
| Path traversal | `routes/profileImageUrlUpload.js` | Profile-image filename built from user input (now **remediated** — see below). |

### Option B — the SCM / pull-request flow (the money demo)

1. In the Snyk UI, confirm the repo is imported under **Integrations → GitHub** (the Snyk GitHub App must have access).
2. Open the project; Snyk Code shows the findings above with severity, the vulnerable line, and a data-flow trace.
3. Open a PR that fixes one issue — Snyk's **PR checks** comment inline and gate the merge. The repo already contains remediated versions of two findings to demonstrate the "after" state:
   - [routes/fileUpload.js](routes/fileUpload.js) — the Zip-Slip path is now normalized with `path.basename` and constrained to `uploads/complaints/`.
   - [routes/profileImageUrlUpload.js](routes/profileImageUrlUpload.js) — the extension is allow-listed and the filename sanitized with `path.basename`.

> **Narrative:** "Snyk scans the code on every push and every PR. The SQL injection in `login.js` is exactly the kind of flaw it catches before it merges — and here's the fix flowing back as a reviewed pull request."
>
> Leave the SQL injection in `login.js` **unfixed** on the demo branch so there's always a live finding to show.

---

## 3. Scan the container image

Finds OS-package and Node dependency vulnerabilities baked into the image.

```shell
snyk container test clintonherget/snyk-juice-shop:latest
```

> If you get "unable to find image", you skipped the `docker pull` in step 0 — run it, then re-run this.

What to point out:

- A vulnerability summary grouped by severity (this older fork ships with many — great for a demo).
- **Base image recommendations** — Snyk suggests slimmer/patched base images that cut the vuln count. The highest-value remediation to show.

```
Testing clintonherget/snyk-juice-shop:latest...

Issues to fix by upgrading:
  Upgrade <pkg>@<ver> to <pkg>@<ver> to fix
  ✗ <Vuln title> [High Severity][CVE-…]
  ...

Organization:      your-org
Package manager:   deb / npm
Tested N dependencies for known issues, found X issues.

Base Image Recommendations  ← the money slide
...
```

Filter the noise when presenting:

```shell
snyk container test clintonherget/snyk-juice-shop:latest --severity-threshold=high
```

---

## 4. Scan the Kubernetes manifests (IaC)

Catches *configuration* problems in the YAML, independent of the image.

```shell
snyk iac test k8s-src/
```

Expected findings on `juice-shop-deploy.yaml` (the demo highlights):

| Finding | Severity | Why it matters |
| :---- | :---- | :---- |
| **Container running in privileged mode** | **High** | Full host access — the headline finding |
| Container could run as root | Medium | No `runAsNonRoot` / `runAsUser` set |
| No CPU/memory limits | Medium | Resource exhaustion / DoS risk |
| `allowPrivilegeEscalation` not disabled | Medium | Privilege escalation path |
| Root filesystem not read-only | Low/Med | Easier tampering / persistence |
| Capabilities not dropped | Low | Excess Linux capabilities |

```
Testing k8s-src/...

Infrastructure as code issues:
  ✗ Container is running in privileged mode [High] in Deployment
    info:   ...
    Path:   [DocId: 0] > input > spec > template > spec > containers[juice-shop] > securityContext > privileged
    Resolve: Set `securityContext.privileged` to `false`
  ...

Tested k8s-src for known issues, found N issues
```

### The "after" moment

Run the same scan against the hardened file to show the count drop:

```shell
snyk iac test k8s-src/juice-shop-deploy-hardened.yaml
```

Then redeploy the hardened version live:

```shell
kubectl apply -f k8s-src/juice-shop-deploy-hardened.yaml
kubectl rollout status deployment/snyk-juice-shop
```

> Narrative: "Same app, same image — we just fixed how it's *configured*. Snyk caught the privileged container and the rest before it ever hit the cluster."
>
> If the hardened pod crash-loops (it's an old image), the read-only root filesystem is the likely cause — see the note in `juice-shop-deploy-hardened.yaml` for the one-line revert. The IaC scan still passes regardless.

---

## 5. Monitor in the Snyk UI

`test` is point-in-time and exits non-zero on findings (great for CI gates). `monitor` / `--report` pushes results to the Snyk platform so they appear in the dashboard and get continuously re-tested as new CVEs are disclosed.

```shell
# Container image → shows up as a project in the Snyk UI
snyk container monitor clintonherget/snyk-juice-shop:latest

# IaC findings → send to the platform
snyk iac test k8s-src/ --report
```

After running, open the printed `https://app.snyk.io/...` link and show the project, the severity breakdown, and that new vulns surface automatically over time.

---

## 6. Tear down

```shell
kubectl delete -f k8s-src/
```

This removes the Deployment and Service from the `default` namespace.

---

## Quick command cheat sheet

```shell
# Setup
docker pull --platform linux/amd64 clintonherget/snyk-juice-shop:latest

# Deploy
kubectl apply -f k8s-src/
kubectl port-forward deployment/snyk-juice-shop 3000:3000

# Scan
snyk code test                                              # source code (SAST) — SQLi in login.js
snyk container test clintonherget/snyk-juice-shop:latest    # image CVEs
snyk iac test k8s-src/                                       # kubernetes misconfigs
snyk container monitor clintonherget/snyk-juice-shop:latest # push image to Snyk UI
snyk iac test k8s-src/ --report                             # push IaC to Snyk UI

# Fix + redeploy
snyk iac test k8s-src/juice-shop-deploy-hardened.yaml
kubectl apply -f k8s-src/juice-shop-deploy-hardened.yaml

# Clean up
kubectl delete -f k8s-src/
```

## Demo tips

- **Pull the image and run `snyk auth` beforehand** so the live run is fast.
- Run the **IaC before/after** back-to-back — the dropping issue count (especially the High-severity privileged finding) is the most visual part.
- The **base image recommendation** from `snyk container test` is the strongest "what do I do about it" beat.
- `--severity-threshold=high` keeps the terminal readable on a projector.
- Exit codes: Snyk returns **1** when issues are found — exactly how you'd gate a CI pipeline.

> Note: exact vulnerability counts and CVE IDs vary with the image and the date you run it (Snyk's DB updates constantly). The output blocks above are illustrative of shape, not exact numbers.
