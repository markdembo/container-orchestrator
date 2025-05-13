from flask import Flask, send_file, request, jsonify
import os

app = Flask(__name__)
TEXT_FILE = 'index.html'

def update_html_text(new_text):
    try:
        with open(TEXT_FILE, 'r') as f:
            content = f.read()
        new_content = content.replace('Hello, Beautiful World!', new_text)
        with open(TEXT_FILE, 'w') as f:
            f.write(new_content)
        return True
    except Exception as e:
        print(f"Error updating file: {e}")
        return False

@app.route('/')
def home():
    return send_file(TEXT_FILE)

@app.route('/update-text', methods=['POST'])
def update_text():
    data = request.get_json()
    if not data or 'text' not in data:
        return jsonify({'error': 'No text provided'}), 400

    new_text = data['text']
    if update_html_text(new_text):
        return jsonify({'message': 'Text updated successfully'}), 200
    else:
        return jsonify({'error': 'Failed to update text'}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)