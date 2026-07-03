"""
Smart Health AI — Streamlit dashboard.

Thin UI layer over the shared core (core/rules.py, core/llm.py).
For mobile-app integration, use api.py (FastAPI) instead.
"""
import os
import glob
import streamlit as st
from PIL import Image

from core import (
    analyze_vitals,
    build_vitals_summary,
    ask_llm,
)
from core.config import PRODUCT_NAME, PRODUCT_TAGLINE

# ── Optional features (voice + OCR) ──
try:
    import pytesseract
    OCR_AVAILABLE = True
except Exception:
    OCR_AVAILABLE = False

try:
    import speech_recognition as sr
    VOICE_AVAILABLE = True
except Exception:
    VOICE_AVAILABLE = False

# Optional RAG — loads local PDFs if present
try:
    from langchain_community.document_loaders import PyPDFLoader
    from langchain_text_splitters import RecursiveCharacterTextSplitter
    from langchain_community.embeddings import HuggingFaceEmbeddings
    from langchain_community.vectorstores import FAISS
    RAG_AVAILABLE = True
except Exception:
    RAG_AVAILABLE = False


# ─────────────────────────────────────────────
# PAGE CONFIG
# ─────────────────────────────────────────────
st.set_page_config(
    page_title=PRODUCT_NAME,
    page_icon="🩺",
    layout="wide",
    initial_sidebar_state="expanded",
)

# ─────────────────────────────────────────────
# CSS - Professional Medical Dark Theme
# ─────────────────────────────────────────────
st.markdown("""
<style>
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=Syne:wght@700;800&display=swap');

*, *::before, *::after { box-sizing: border-box; }

html, body, .stApp {
    background-color: #080C14 !important;
    color: #E2E8F0 !important;
    font-family: 'DM Sans', sans-serif !important;
}

#MainMenu, footer, header { visibility: hidden; }
.block-container {
    padding: 1.5rem 2rem !important;
    max-width: 100% !important;
}

.sv-header {
    display: flex; align-items: center; gap: 14px;
    padding: 18px 0 12px 0;
    border-bottom: 1px solid #1E2A3A;
    margin-bottom: 1.5rem;
}
.sv-header .logo {
    width: 42px; height: 42px;
    background: linear-gradient(135deg, #0EA5E9, #06B6D4);
    border-radius: 12px;
    display: flex; align-items: center; justify-content: center;
    font-size: 22px;
    box-shadow: 0 0 20px #0EA5E940;
}
.sv-header h1 {
    font-family: 'Syne', sans-serif !important;
    font-size: 1.6rem !important;
    font-weight: 800 !important;
    color: #F1F5F9 !important;
    margin: 0 !important; padding: 0 !important;
    letter-spacing: -0.5px;
}
.sv-header span {
    font-size: 0.75rem;
    color: #64748B;
    letter-spacing: 2px;
    text-transform: uppercase;
    font-weight: 500;
}

[data-testid="stSidebar"] {
    background-color: #0D1420 !important;
    border-right: 1px solid #1E2A3A !important;
}
[data-testid="stSidebar"] .block-container { padding: 1.5rem 1.2rem !important; }
.sidebar-title {
    font-family: 'Syne', sans-serif;
    font-size: 1rem; font-weight: 700;
    color: #94A3B8;
    text-transform: uppercase;
    letter-spacing: 2px;
    margin-bottom: 1rem; padding-bottom: 0.5rem;
    border-bottom: 1px solid #1E2A3A;
}
[data-testid="stNumberInput"] label { color: #94A3B8 !important; font-size: 0.82rem !important; }
[data-testid="stNumberInput"] input {
    background-color: #111827 !important;
    border: 1px solid #1E2A3A !important;
    border-radius: 8px !important;
    color: #F1F5F9 !important;
}
[data-testid="stToggle"] label { color: #CBD5E1 !important; }
.stButton > button {
    background: linear-gradient(135deg, #0EA5E9, #0284C7) !important;
    color: white !important; border: none !important;
    border-radius: 10px !important;
    font-weight: 600 !important; font-size: 0.88rem !important;
    padding: 0.5rem 1.2rem !important;
    box-shadow: 0 2px 12px #0EA5E930 !important;
}
.stButton > button:hover {
    transform: translateY(-1px) !important;
    box-shadow: 0 4px 20px #0EA5E950 !important;
}

.alert-card {
    border-radius: 10px; padding: 10px 14px;
    margin: 6px 0; font-size: 0.85rem;
    display: flex; align-items: flex-start; gap: 10px;
}
.alert-critical { background: #1A0A0A; border: 1px solid #EF444480; color: #FCA5A5; }
.alert-danger   { background: #1A1000; border: 1px solid #F9731680; color: #FDBA74; }
.alert-warning  { background: #1A1500; border: 1px solid #EAB30880; color: #FDE68A; }
.alert-normal   { background: #0A1A0F; border: 1px solid #22C55E80; color: #86EFAC; }
.alert-sensor   { background: #0F1424; border: 1px solid #60A5FA80; color: #BFDBFE; }
.alert-unknown  { background: #14141A; border: 1px solid #52525B80; color: #D4D4D8; }
.alert-card .alert-param { font-weight: 600; min-width: 120px; }
.alert-card .alert-msg { color: #94A3B8; font-size: 0.8rem; margin-top: 2px; }

.severity-badge {
    display: inline-block; padding: 4px 14px;
    border-radius: 20px; font-size: 0.78rem;
    font-weight: 700; letter-spacing: 1px;
    text-transform: uppercase; margin: 8px 0 12px 0;
}
.sev-critical { background: #EF444420; color: #EF4444; border: 1px solid #EF444460; }
.sev-danger   { background: #F9731620; color: #F97316; border: 1px solid #F9731660; }
.sev-warning  { background: #EAB30820; color: #EAB308; border: 1px solid #EAB30860; }
.sev-normal   { background: #22C55E20; color: #22C55E; border: 1px solid #22C55E60; }
.sev-sensor   { background: #60A5FA20; color: #60A5FA; border: 1px solid #60A5FA60; }
.sev-unknown  { background: #52525B20; color: #A1A1AA; border: 1px solid #52525B60; }

.vitals-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px; }
.vital-card {
    background: #111827; border: 1px solid #1E2A3A;
    border-radius: 10px; padding: 10px 12px; text-align: center;
}
.vital-card .vc-label { font-size: 0.7rem; color: #64748B; text-transform: uppercase; letter-spacing: 1px; }
.vital-card .vc-value { font-family: 'Syne', sans-serif; font-size: 1.3rem; font-weight: 700; color: #0EA5E9; margin: 2px 0; }
.vital-card .vc-unit  { font-size: 0.7rem; color: #475569; }

.section-label {
    font-size: 0.72rem; font-weight: 600;
    letter-spacing: 2px; text-transform: uppercase;
    color: #475569; margin-bottom: 0.5rem; margin-top: 1rem;
}

hr { border-color: #1E2A3A !important; margin: 1rem 0 !important; }
</style>
""", unsafe_allow_html=True)

# ─────────────────────────────────────────────
# SESSION STATE
# ─────────────────────────────────────────────
if "messages" not in st.session_state:
    st.session_state.messages = []
if "chat_history" not in st.session_state:
    st.session_state.chat_history = []
if "_vitals_pending" not in st.session_state:
    st.session_state._vitals_pending = None


# ─────────────────────────────────────────────
# OPTIONAL RAG
# ─────────────────────────────────────────────
@st.cache_resource
def load_vector_db():
    if not RAG_AVAILABLE:
        return None
    embeddings = HuggingFaceEmbeddings(
        model_name="all-MiniLM-L6-v2", model_kwargs={"device": "cpu"}
    )
    if os.path.exists("medical_db"):
        try:
            return FAISS.load_local("medical_db", embeddings, allow_dangerous_deserialization=True)
        except TypeError:
            return FAISS.load_local("medical_db", embeddings)
    pdf_files = glob.glob("*.pdf")
    if not pdf_files:
        return None
    docs = []
    for f in pdf_files:
        try:
            docs.extend(PyPDFLoader(f).load())
        except Exception:
            pass
    if not docs:
        return None
    splits = RecursiveCharacterTextSplitter(chunk_size=500, chunk_overlap=50).split_documents(docs)
    db = FAISS.from_documents(splits, embeddings)
    db.save_local("medical_db")
    return db


def get_relevant_context(db, question, k=3):
    if db is None:
        return ""
    try:
        docs = db.similarity_search(question, k=k)
        return "\n".join(doc.page_content for doc in docs)
    except Exception:
        return ""


with st.spinner(f"Loading {PRODUCT_NAME}..."):
    vector_db = load_vector_db()


# ─────────────────────────────────────────────
# SIDEBAR
# ─────────────────────────────────────────────
def sev_classes(sev: str):
    m = {
        "CRITICAL": ("sev-critical", "alert-critical", "🔴"),
        "DANGER":   ("sev-danger",   "alert-danger",   "🟠"),
        "WARNING":  ("sev-warning",  "alert-warning",  "🟡"),
        "NORMAL":   ("sev-normal",   "alert-normal",   "🟢"),
        "SENSOR_ERROR": ("sev-sensor", "alert-sensor", "📡"),
        "UNKNOWN":  ("sev-unknown",  "alert-unknown",  "❔"),
    }
    return m.get(sev, m["UNKNOWN"])


with st.sidebar:
    st.markdown('<div class="sidebar-title">🩺 Vitals Monitor</div>', unsafe_allow_html=True)

    use_vitals = st.toggle("Enable Live Vitals Analysis", value=False)

    if use_vitals:
        st.markdown('<div class="section-label">Sensor Readings</div>', unsafe_allow_html=True)
        hr   = st.number_input("Heart Rate (bpm)",          min_value=0,   max_value=300,  value=75)
        spo2 = st.number_input("SpO₂ (%)",                  min_value=0,   max_value=100,  value=98)
        rr   = st.number_input("Resp. Rate (br/min, opt.)", min_value=0,   max_value=60,   value=16)
        temp = st.number_input("Temperature (°C)",          min_value=30.0, max_value=45.0, value=37.0, step=0.1)

        st.markdown(f"""
        <div class="vitals-grid">
            <div class="vital-card"><div class="vc-label">Heart Rate</div><div class="vc-value">{hr}</div><div class="vc-unit">bpm</div></div>
            <div class="vital-card"><div class="vc-label">SpO₂</div><div class="vc-value">{spo2}</div><div class="vc-unit">%</div></div>
            <div class="vital-card"><div class="vc-label">Resp. Rate</div><div class="vc-value">{rr}</div><div class="vc-unit">br/min</div></div>
            <div class="vital-card"><div class="vc-label">Temp</div><div class="vc-value">{temp}</div><div class="vc-unit">°C</div></div>
        </div>
        """, unsafe_allow_html=True)

        if st.button("🔍 Analyze Vitals", use_container_width=True):
            alerts, severity = analyze_vitals(hr, spo2, rr, temp)

            st.markdown('<div class="section-label">Analysis Result</div>', unsafe_allow_html=True)
            sev_class, _, sev_icon = sev_classes(severity)
            st.markdown(f'<span class="severity-badge {sev_class}">{sev_icon} {severity}</span>',
                        unsafe_allow_html=True)

            for level, param, value, msg in alerts:
                _, card_class, icon = sev_classes(level)
                st.markdown(f"""
                <div class="alert-card {card_class}">
                    <span>{icon}</span>
                    <div>
                        <div class="alert-param">{param}: {value}</div>
                        <div class="alert-msg">{msg}</div>
                    </div>
                </div>""", unsafe_allow_html=True)

            vitals_summary = build_vitals_summary(hr, spo2, rr, temp)
            st.session_state.messages.append({
                "role": "user",
                "content": f"📊 Vitals submitted: {vitals_summary}"
            })
            st.session_state._vitals_pending = {
                "question": f"Patient vitals: {vitals_summary}. Severity: {severity}. Explain and recommend.",
                "vitals_summary": vitals_summary,
                "severity": severity,
                "alerts": alerts,
            }
            st.rerun()

    st.markdown("---")
    st.markdown('<div class="section-label">About</div>', unsafe_allow_html=True)
    st.markdown(
        f"<span style='color:#475569;font-size:0.8rem;'>{PRODUCT_NAME} · {PRODUCT_TAGLINE}</span>",
        unsafe_allow_html=True,
    )


# ─────────────────────────────────────────────
# MAIN — HEADER
# ─────────────────────────────────────────────
st.markdown(f"""
<div class="sv-header">
    <div class="logo">🩺</div>
    <div>
        <h1>{PRODUCT_NAME}</h1>
        <span>{PRODUCT_TAGLINE}</span>
    </div>
</div>
""", unsafe_allow_html=True)

# ─────────────────────────────────────────────
# CHAT AREA
# ─────────────────────────────────────────────
chat_container = st.container(height=480, border=False)
with chat_container:
    if not st.session_state.messages:
        st.markdown(f"""
        <div style="text-align:center; padding: 3rem 1rem; color: #2D3748;">
            <div style="font-size:3rem; margin-bottom:1rem;">🩺</div>
            <div style="font-family:'Syne',sans-serif; font-size:1.1rem; color:#4A5568; font-weight:700;">
                How can I help you today?
            </div>
            <div style="font-size:0.85rem; color:#2D3748; margin-top:0.5rem;">
                Ask a medical question or use the Vitals Monitor on the left
            </div>
        </div>
        """, unsafe_allow_html=True)
    else:
        for msg in st.session_state.messages:
            with st.chat_message(msg["role"]):
                st.markdown(msg["content"])


# ─────────────────────────────────────────────
# INPUT BAR
# ─────────────────────────────────────────────
user_input = None
col_mic, col_cam, col_text = st.columns([1, 1, 10])

with col_mic:
    if VOICE_AVAILABLE:
        if st.button("🎤", help="Voice input"):
            r = sr.Recognizer()
            try:
                with sr.Microphone() as source:
                    st.toast("🎤 Listening...", icon="🎙️")
                    try:
                        audio = r.listen(source, timeout=5)
                        user_input = r.recognize_google(audio, language="en-US")
                    except Exception:
                        st.error("Voice not recognized.")
            except Exception as e:
                st.error(f"Microphone unavailable: {e}")
    else:
        st.button("🎤", help="Voice input (disabled — install speech_recognition + pyaudio)", disabled=True)

with col_cam:
    if OCR_AVAILABLE:
        with st.popover("📷"):
            uploaded_image = st.file_uploader("Upload medical image", type=["png", "jpg", "jpeg"], label_visibility="collapsed")
            if uploaded_image:
                image = Image.open(uploaded_image)
                st.image(image, width=160)
                if st.button("Analyze Image"):
                    try:
                        text = pytesseract.image_to_string(image)
                        user_input = f"Analyze this medical report:\n{text}"
                    except Exception:
                        st.error("OCR error. Is Tesseract installed?")
    else:
        st.button("📷", help="Image OCR (disabled — install pytesseract + Tesseract binary)", disabled=True)

with col_text:
    with st.form(key="chat_form", clear_on_submit=True):
        c1, c2 = st.columns([9, 1])
        with c1:
            typed = st.text_input(f"Ask {PRODUCT_NAME} anything...", label_visibility="collapsed")
        with c2:
            send = st.form_submit_button("➤")
        if send and typed:
            user_input = typed


# ─────────────────────────────────────────────
# PROCESS
# ─────────────────────────────────────────────
if user_input:
    st.session_state.messages.append({"role": "user", "content": user_input})
    st.rerun()

# Vitals pending
if st.session_state._vitals_pending:
    pending = st.session_state._vitals_pending
    st.session_state._vitals_pending = None
    with chat_container:
        with st.chat_message("assistant"):
            with st.spinner("AI analyzing vitals..."):
                try:
                    context = get_relevant_context(vector_db, pending["question"])
                    result = ask_llm(
                        question=pending["question"],
                        chat_history=st.session_state.chat_history,
                        vitals_summary=pending["vitals_summary"],
                        severity=pending["severity"],
                        rule_alerts=pending["alerts"],
                        retrieval_context=context,
                    )
                    response = result["answer"]
                    st.session_state.chat_history.append({"role": "user", "content": pending["question"]})
                    st.session_state.chat_history.append({"role": "assistant", "content": response})
                except Exception as e:
                    response = f"System error: {e}"
                st.markdown(response)
    st.session_state.messages.append({"role": "assistant", "content": response})
    st.rerun()

# Normal question
if st.session_state.messages and st.session_state.messages[-1]["role"] == "user":
    last = st.session_state.messages[-1]["content"]
    if not last.startswith("📊 Vitals submitted"):
        with chat_container:
            with st.chat_message("assistant"):
                with st.spinner("Thinking..."):
                    try:
                        context = get_relevant_context(vector_db, last)
                        result = ask_llm(
                            question=last,
                            chat_history=st.session_state.chat_history,
                            retrieval_context=context,
                        )
                        response = result["answer"]
                        st.session_state.chat_history.append({"role": "user", "content": last})
                        st.session_state.chat_history.append({"role": "assistant", "content": response})
                    except Exception as e:
                        response = f"System error: {e}"
                    st.markdown(response)
        st.session_state.messages.append({"role": "assistant", "content": response})
