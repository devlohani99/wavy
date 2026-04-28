import { Component } from 'react';

class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, errorInfo) {
    console.error('App crashed', error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#F4EBD9] text-[#4A3F35] flex flex-col items-center justify-center gap-6 px-6 text-center">
          <div>
            <p className="text-3xl font-semibold">Something went wrong.</p>
            <p className="text-stone-500 mt-2">Try refreshing the page or jump back to the homepage.</p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={this.handleReset}
              className="rounded-full bg-sky-500 px-6 py-2 text-sm font-semibold text-[#3E342B] shadow-lg shadow-sky-500/30 transition hover:bg-sky-400"
            >
              Try again
            </button>
            <a
              href="/"
              className="rounded-full border border-stone-300 px-6 py-2 text-sm font-semibold text-[#3E342B]/80 hover:bg-[#EAE0C8]"
            >
              Go home
            </a>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default AppErrorBoundary;
