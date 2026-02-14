# How to Start the App

## 1. Backend (API)

Open a terminal in the project folder and run:

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

- API: **http://127.0.0.1:8000**
- Docs: **http://127.0.0.1:8000/docs**
- Install dependencies only the first time; after that just run the `uvicorn` line.

---

## 2. Frontend (Web UI)

Open **another** terminal and run:

```bash
cd frontend
python -m http.server 3000
```

Then open in your browser:

**http://localhost:3000**

- Use **http://localhost:3000/index.html** to log in or create an account.

---

## Summary

| What        | Command                                      | URL                    |
|------------|-----------------------------------------------|------------------------|
| Backend    | `cd backend` then `uvicorn main:app --reload --host 0.0.0.0 --port 8000` | http://127.0.0.1:8000  |
| Frontend   | `cd frontend` then `python -m http.server 3000` | http://localhost:3000   |

Keep both terminals open while you use the app.

---

## On LAN (e.g. DRDO)

- Backend: same command; others use **http://\<this-PC-IP\>:8000**
- Frontend: others open **http://\<this-PC-IP\>:3000** (or serve `frontend` from the same machine).
