import streamlit as st
from component import get_component

def main():
    st.set_page_config(
        page_title="BuilderGPT - AI Minecraft Structure Generator",
        page_icon="🧱",
        layout="wide",
        initial_sidebar_state="expanded",
    )
    
    component = get_component()
    component.render()

if __name__ == "__main__":
    main()
