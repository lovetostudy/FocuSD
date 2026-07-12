import os
from flask import Flask, request, jsonify

app = Flask(__name__)
DATA = os.environ.get("DATA_DIR", os.path.join(os.path.dirname(__file__), "data"))
STORE = os.path.join(DATA, "todos")


@app.route("/sync", methods=["GET"])
def pull():
    os.makedirs(STORE, exist_ok=True)
    files = {}
    for f in os.listdir(STORE):
        if f.endswith(".md"):
            p = os.path.join(STORE, f)
            with open(p, encoding="utf-8") as fh:
                files[f] = fh.read()
    return jsonify({"files": files})


@app.route("/sync", methods=["PUT"])
def push():
    data = request.get_json()
    files = data.get("files", {})
    device = data.get("deviceId", "unknown")
    app.logger.info("sync push device=%s files=%d", device, len(files))
    os.makedirs(STORE, exist_ok=True)
    for fname, content in files.items():
        safe = os.path.basename(fname)
        if safe.endswith(".md"):
            with open(os.path.join(STORE, safe), "w", encoding="utf-8") as fh:
                fh.write(content)
    return jsonify({"ok": True})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 3456))
    app.run(host="0.0.0.0", port=port)
